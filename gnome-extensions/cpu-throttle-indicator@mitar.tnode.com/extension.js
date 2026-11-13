import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {decodeChargingPower, findBatteryFile} from './battery.js';
import {FAN_MAX_RPM, findApuSensor, findBoardSensorFiles, findFanFiles} from './ec.js';
import {findMemorySensors, findSsdSensors, findWifiSensors} from './hwmon.js';
import {
    CORE_GROUPS, REASONS, decodeMetrics, dominantReason, findClockLimits, findMetricsFile, throttleShares,
} from './metrics.js';

const SAMPLE_INTERVAL_S = 2;

// The file in which the kernel adds up the time all CPUs spent in each state since boot.
const CPU_TIMES_PATH = '/proc/stat';

// Below this share of an interval a reason counts as holding nothing back. The processor brushes against its limits
// briefly whenever it boosts, and reporting that would leave the indicator showing almost all of the time.
const THRESHOLD_PERCENT = 10;

// The number of samples in a row which have to stay under the threshold before the indicator goes away again.
// Starting a program drains the fast power budget for about one sample, so leaving at the first quiet sample would
// blink.
const HIDE_AFTER_SAMPLES = 2;

// The hottest core's temperature from which a fan is expected to spin. The embedded controller runs the fan from the
// sensors on the board only, and starts it once one of them passes about 50 C, which the board reaches some time
// after the cores reach this.
const FAN_NEEDED_ABOVE_C = 70;

// The number of samples in a row in which the hottest core has to be at FAN_NEEDED_ABOVE_C or more, with no fan
// spinning in that time or no board reading changing for BOARD_STALE_AFTER_S, before that is shown as the fan not
// following the heat. It has to outlast the board warming up to where the EC starts the fan. Starting from a cool board
// with the fan off, the EC was measured to start the fan at most about 10 seconds after the hottest core reached
// FAN_NEEDED_ABOVE_C, for loads from a few threads to all of them, while lighter loads warm the board enough before the
// cores reach that temperature, or never bring the cores to it.
const FAULT_AFTER_HOT_SAMPLES = 15;

// How long none of the board's temperature readings may change, with the hottest core at FAN_NEEDED_ABOVE_C or more
// for the last FAULT_AFTER_HOT_SAMPLES in a row, before that is shown as the fan not following the heat. The EC keeps
// reporting the last temperature it read from a board sensor it cannot read any more, and the fan then keeps the speed
// that temperature asks for, which can be a slow one as well as off. The readings are in whole degrees and can all
// stay the same for minutes while the processor idles, but once it heats up, at least one of them changes within
// seconds, until a steady load settles the board.
const BOARD_STALE_AFTER_S = 120;

// The share of FAN_MAX_RPM from which the EC's fan target counts as full speed, at which board readings which stopped
// changing are not shown as the fan not following the heat. A build on all threads held at the sustained power limit,
// with the fan at full speed, settled the board so that all of its readings stayed the same for minutes, the same as
// when the EC stops reading them. A reading which stopped changing there leaves the fan close to the fastest a fresh
// one could ask for anyway. The share is under the whole of it so that a board which settles just under the top of a
// sensor's fan ramp counts as well.
const FAN_FULL_TARGET_SHARE = 0.95;

// The theme's red pill for a top bar indicator which needs attention, the one the shell shows while recording the
// screen. Borrowing it keeps the warning in the theme's colors, light or dark.
const WARNING_PANEL_STYLE_CLASS = 'screen-recording-indicator';

// The style class of a menu row which shows a critical temperature.
const CRITICAL_ROW_STYLE_CLASS = 'cpu-throttle-indicator-critical';

/**
 * Formats a frequency for the menu.
 *
 * @param {number} frequency - the frequency in MHz
 * @param {number|null} maxFrequency - the frequency in MHz reached when nothing holds it back, or null when unknown
 * @returns {string} the frequency, with its share of the maximum when that is known
 */
function formatFrequency(frequency, maxFrequency) {
    return maxFrequency ? `${frequency} MHz, ${Math.round(100 * frequency / maxFrequency)}%` : `${frequency} MHz`;
}

/**
 * Formats a power for the menu.
 *
 * @param {number|null} power - the power in watts, or null when unknown
 * @returns {string} the power
 */
function formatPower(power) {
    return power === null ? 'unknown' : `${power.toFixed(1)} W`;
}

const Indicator = GObject.registerClass(
class ThrottleIndicator extends PanelMenu.Button {
    /**
     * @param {string} iconsPath - the directory of the extension's icons
     * @param {object} devices - the files the indicator reads
     * @param {Gio.File} devices.metricsFile - the metrics table, as findMetricsFile returned it
     * @param {object} devices.clockLimits - the frequencies findClockLimits returned
     * @param {object[]} devices.fanFiles - the fans, as findFanFiles returned them
     * @param {Gio.File[]} devices.boardSensorFiles - the board's sensors, as findBoardSensorFiles returned them
     * @param {{file: Gio.File, critical: number|null}|null} devices.apuSensor - the APU's sensor, as findApuSensor
     *   returned it
     * @param {Gio.File|null} devices.batteryFile - the battery's state, as findBatteryFile returned it
     * @param {{name: string, file: Gio.File, critical: number|null}[]} devices.temperatureSensors - the other hwmon
     *   temperature sensors to show in the menu, each with the name to show it under and its critical limit in degrees
     *   Celsius, or null when it has none
     */
    _init(iconsPath, {
        metricsFile, clockLimits, fanFiles, boardSensorFiles, apuSensor, batteryFile, temperatureSensors,
    }) {
        super._init(0, 'CPU Throttle Indicator');

        this._file = metricsFile;
        this._clockLimits = clockLimits;
        this._cpuTimesFile = Gio.File.new_for_path(CPU_TIMES_PATH);
        this._batteryFile = batteryFile;
        this._readingBattery = false;
        this._cancellable = new Gio.Cancellable();
        this._previous = null;
        this._reading = false;
        this._readingCpuTimes = false;
        // The total and the idle time of all CPUs at the last reading, in the kernel's clock ticks.
        this._cpuTimes = null;
        this._samplesUnderThreshold = 0;
        this._samplesHot = 0;
        this._samplesFanOffWhileHot = 0;
        // The temperature is undefined until the sensor has been read, and null while the EC reports it as failed.
        this._boardSensors = boardSensorFiles.map(boardFile => ({
            file: boardFile,
            reading: false,
            temperature: undefined,
        }));
        // The monotonic time in microseconds at which a board reading last changed.
        this._boardChangedAt = null;
        this._boardStale = false;
        // The reason the top bar names, which stays for HIDE_AFTER_SAMPLES after it stops holding anything back.
        this._throttle = null;
        this._icons = {
            power: Gio.icon_new_for_string(`${iconsPath}/cpu-throttle-power-symbolic.svg`),
            thermal: Gio.icon_new_for_string(`${iconsPath}/cpu-throttle-thermal-symbolic.svg`),
            // The platform does not report why it asserted PROCHOT, so it is shown with the shell's own warning
            // icon rather than being presented as either a power or a temperature limit.
            platform: new Gio.ThemedIcon({name: 'dialog-warning-symbolic'}),
        };

        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this._reasonLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._icon);
        box.add_child(this._reasonLabel);
        this.add_child(box);

        this._warningItem = this._addWarning('Fan does not follow the processor heat',
            ['Fan control may be stuck on old temperatures.']);

        this._shareLabels = new Map();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Limits'));
        for (const reason of REASONS)
            this._shareLabels.set(reason.key, this._addRow(reason.label));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Frequency'));
        this._frequencyLabels = CORE_GROUPS.map(group => this._addRow(`${group.name} cores`));
        this._graphicsFrequencyLabel = this._addRow('GPU');
        this._npuFrequencyLabel = this._addRow('NPU');
        this._memoryFrequencyLabel = this._addRow('DRAM');
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Usage'));
        this._cpuUsageLabel = this._addRow('CPU');
        this._graphicsUsageLabel = this._addRow('GPU');
        this._npuUsageLabel = this._addRow('NPU');
        if (fanFiles.length)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Fans'));
        // Each row of the section shows one file, either the speed of a fan or its target.
        this._fanRows = [];
        for (const fan of fanFiles) {
            // Fans are numbered only when there are several of them to tell apart.
            const name = fanFiles.length === 1 ? 'Fan' : `Fan ${fan.number}`;
            this._fanRows.push({
                kind: 'speed',
                file: fan.file,
                label: this._addRow(name),
                reading: false,
                // Undefined until the fan has been read, and null while the EC reports the fan as stalled.
                speed: undefined,
            });
            if (fan.targetFile) {
                this._fanRows.push({
                    kind: 'target',
                    file: fan.targetFile,
                    label: this._addRow(`${name} target`),
                    reading: false,
                    // Undefined until the target has been read.
                    speed: undefined,
                });
            }
        }
        this._fanSpeedRows = this._fanRows.filter(row => row.kind === 'speed');
        this._fanTargetRows = this._fanRows.filter(row => row.kind === 'target');
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Temperature'));
        const addTemperatureRow = sensor => ({
            file: sensor.file,
            critical: sensor.critical,
            label: this._addRow(sensor.name),
            reading: false,
        });
        // The APU's temperature which the EC reads leads the section, followed by the temperatures from the metrics
        // table.
        this._temperatureRows = apuSensor ? [addTemperatureRow({...apuSensor, name: 'APU'})] : [];
        this._coreLabel = this._addRow('CPU');
        this._gfxLabel = this._addRow('GPU');
        this._socLabel = this._addRow('SoC');
        this._temperatureRows.push(...temperatureSensors.map(addTemperatureRow));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Power'));
        // The laptop's power is the APU's and the other power together, and the APU's is its four parts together,
        // which are indented under it.
        this._systemPowerLabel = this._addRow('Laptop');
        this._apuPowerLabel = this._addRow('APU');
        this._corePowerLabel = this._addRow('CPU', true);
        this._graphicsPowerLabel = this._addRow('GPU', true);
        this._npuPowerLabel = this._addRow('NPU', true);
        this._socPowerLabel = this._addRow('SoC', true);
        // The power which charges the battery is not part of the laptop's, and its row is shown only while the battery
        // charges.
        this._batteryPowerLabel = this._addRow('Battery');
        this._setRowVisible(this._batteryPowerLabel, false);
        this._otherPowerLabel = this._addRow('Other');

        // The hwmon temperature sensors and the battery are shown only in the menu, so they are read only while it is
        // open, and once right as it opens. A read of the sensor of an NVMe drive or of a wireless card sends a command
        // to the device, which wakes it from a power saving state.
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._sampleTemperatures();
                this._sampleBattery();
            }
        });

        // Nothing is known until two readings have been compared, and until then there is nothing to show.
        this.hide();

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAMPLE_INTERVAL_S, () => {
            this._sample();
            this._sampleCpuTimes();
            this._sampleFans();
            this._sampleBoardSensors();
            if (this.menu.isOpen) {
                this._sampleTemperatures();
                this._sampleBattery();
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._sample();
        this._sampleCpuTimes();
        this._sampleFans();
        this._sampleBoardSensors();
    }

    // PanelMenu.Button connects this to its own destroy signal, and destroys the menu and the container in it, so
    // an override has to chain up for that to still happen.
    _onDestroy() {
        this._cancellable.cancel();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        super._onDestroy();
    }

    /**
     * Adds a row to the menu which names something and leaves room for its value.
     *
     * @param {string} text - the name to show on the left of the row
     * @param {boolean} [indented] - whether the name is indented, as a part of the row above
     * @returns {St.Label} the label on the right of the row, to set the value on
     */
    _addRow(text, indented = false) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        // The theme clears the background of a menu item which does not react to the pointer, so the background which
        // marks a critical temperature is on a box inside the item.
        const box = new St.BoxLayout({style_class: 'cpu-throttle-indicator-row', x_expand: true});
        const value = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Label({
            text,
            style_class: indented ? 'cpu-throttle-indicator-indented' : '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(value);
        item.add_child(box);
        this.menu.addMenuItem(item);
        return value;
    }

    /**
     * Shows or hides a row of the menu.
     *
     * @param {St.Label} label - the label _addRow returned for the row
     * @param {boolean} visible - whether the row is shown
     */
    _setRowVisible(label, visible) {
        // The label is in the box which _addRow put into the menu item.
        label.get_parent().get_parent().visible = visible;
    }

    /**
     * Shows a temperature in a row of the menu, and marks the row while the temperature is critical.
     *
     * @param {St.Label} label - the label _addRow returned for the row
     * @param {number|null} temperature - the temperature in degrees Celsius, or null when the sensor cannot be read
     * @param {boolean} critical - whether the temperature is critical
     */
    _showTemperature(label, temperature, critical) {
        label.text = temperature === null ? 'error' : `${temperature.toFixed(1)} C`;
        const row = label.get_parent();
        if (critical)
            row.add_style_class_name(CRITICAL_ROW_STYLE_CLASS);
        else
            row.remove_style_class_name(CRITICAL_ROW_STYLE_CLASS);
    }

    /**
     * Adds a warning to the menu, hidden until it is shown.
     *
     * @param {string} title - the first line of the warning, saying what is wrong
     * @param {string[]} lines - the lines under the title
     * @returns {PopupMenu.PopupBaseMenuItem} the menu item holding the warning, to show and hide
     */
    _addWarning(title, lines) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({style_class: 'cpu-throttle-indicator-warning', x_expand: true});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({text: title, style_class: 'cpu-throttle-indicator-warning-title'}));
        for (const line of lines)
            text.add_child(new St.Label({text: line}));
        box.add_child(new St.Icon({
            icon_name: 'dialog-warning-symbolic',
            style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(text);
        item.add_child(box);
        item.hide();
        this.menu.addMenuItem(item);
        return item;
    }

    _sample() {
        // A read is answered by the SMU rather than out of memory, so it is kept off the shell's main loop. A read
        // still running when the next one is due is left to finish on its own instead of queueing another behind
        // it, so that a slow one cannot build up a backlog.
        if (this._reading)
            return;
        this._reading = true;
        this._file.load_bytes_async(this._cancellable, (file, result) => {
            let bytes;
            try {
                [bytes] = file.load_bytes_finish(result);
            } catch (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`CPU Throttle Indicator: cannot read ${file.get_path()}: ${error.message}`);
                this._reading = false;
                return;
            }
            this._reading = false;
            // Cancelling happens as the indicator is being destroyed, and a read that had already completed by then
            // still arrives here, with widgets that must not be touched any more.
            if (!this._cancellable.is_cancelled())
                this._update(decodeMetrics(bytes.get_data()), GLib.get_monotonic_time());
        });
    }

    _sampleCpuTimes() {
        // The file is read off the main loop and one read at a time, the same as the metrics table.
        if (this._readingCpuTimes)
            return;
        this._readingCpuTimes = true;
        this._cpuTimesFile.load_bytes_async(this._cancellable, (file, result) => {
            this._readingCpuTimes = false;
            let bytes;
            try {
                [bytes] = file.load_bytes_finish(result);
            } catch (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`CPU Throttle Indicator: cannot read ${file.get_path()}: ${error.message}`);
                return;
            }
            if (this._cancellable.is_cancelled())
                return;
            // The first line holds the times of all CPUs together, as "cpu" followed by the time spent in user, nice,
            // system, idle, iowait, irq, softirq and steal, and then in guest and guest_nice, which user and nice
            // include already. A CPU waiting for I/O is idle.
            const times = new TextDecoder().decode(bytes.get_data()).split('\n', 1)[0].trim().split(/\s+/).slice(1, 9)
                .map(Number);
            const total = times.reduce((sum, time) => sum + time, 0);
            const idle = times[3] + times[4];
            const previous = this._cpuTimes;
            this._cpuTimes = {total, idle};
            if (previous && total > previous.total) {
                const busy = 1 - (idle - previous.idle) / (total - previous.total);
                this._cpuUsageLabel.text = `${Math.round(100 * busy)}%`;
            }
        });
    }

    _sampleBattery() {
        // The file is read off the main loop and one read at a time, the same as the metrics table.
        if (!this._batteryFile || this._readingBattery)
            return;
        this._readingBattery = true;
        this._batteryFile.load_bytes_async(this._cancellable, (file, result) => {
            this._readingBattery = false;
            let bytes;
            try {
                [bytes] = file.load_bytes_finish(result);
            } catch (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`CPU Throttle Indicator: cannot read ${file.get_path()}: ${error.message}`);
                return;
            }
            if (this._cancellable.is_cancelled())
                return;
            const power = decodeChargingPower(bytes.get_data());
            this._setRowVisible(this._batteryPowerLabel, power !== null);
            if (power !== null)
                this._batteryPowerLabel.text = formatPower(power);
        });
    }

    _sampleTemperatures() {
        // Each file is read off the main loop and one read at a time, the same as the metrics table.
        for (const row of this._temperatureRows) {
            if (row.reading)
                continue;
            row.reading = true;
            row.file.load_bytes_async(this._cancellable, (file, result) => {
                row.reading = false;
                let temperature = null;
                try {
                    const [bytes] = file.load_bytes_finish(result);
                    temperature = Number(new TextDecoder().decode(bytes.get_data())) / 1000;
                } catch (error) {
                    if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    // INVALID_DATA is the driver reporting that it cannot read the sensor, as the EC's driver does for
                    // every error state the EC reports for a sensor. Any other error is about reaching the file and
                    // says nothing about the sensor, so the menu keeps showing its last reading.
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.INVALID_DATA)) {
                        console.warn(`CPU Throttle Indicator: cannot read ${file.get_path()}: ${error.message}`);
                        return;
                    }
                }
                if (!this._cancellable.is_cancelled()) {
                    this._showTemperature(row.label, temperature,
                        row.critical !== null && temperature !== null && temperature >= row.critical);
                }
            });
        }
    }

    _sampleFans() {
        // Each file is read off the main loop and one read at a time, the same as the metrics table.
        for (const row of this._fanRows) {
            if (row.reading)
                continue;
            row.reading = true;
            row.file.load_bytes_async(this._cancellable, (file, result) => {
                row.reading = false;
                let speed = null;
                try {
                    const [bytes] = file.load_bytes_finish(result);
                    speed = Number(new TextDecoder().decode(bytes.get_data()));
                } catch (error) {
                    if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    // INVALID_DATA for the speed is the EC reporting the fan as stalled. Any other error, and any error
                    // for the target, is about reaching the EC and says nothing about the fan, so the menu keeps
                    // showing its last reading.
                    if (row.kind !== 'speed' || !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.INVALID_DATA)) {
                        console.warn(`CPU Throttle Indicator: cannot read ${file.get_path()}: ${error.message}`);
                        return;
                    }
                }
                if (!this._cancellable.is_cancelled())
                    this._updateFanRow(row, speed);
            });
        }
    }

    /**
     * Reads the speed of a fan or of its target, and shows it in the menu.
     *
     * @param {object} row - the row the reading is for, as an entry of this._fanRows
     * @param {number|null} speed - the speed in RPM, or null when the EC reports the fan as stalled
     */
    _updateFanRow(row, speed) {
        row.speed = speed;
        row.label.text = speed === null ? 'stalled' : `${speed} RPM, ${Math.round(100 * speed / FAN_MAX_RPM)}%`;
    }

    _sampleBoardSensors() {
        // Each file is read off the main loop and one read at a time, the same as the metrics table.
        for (const sensor of this._boardSensors) {
            if (sensor.reading)
                continue;
            sensor.reading = true;
            sensor.file.load_bytes_async(this._cancellable, (file, result) => {
                sensor.reading = false;
                let temperature = null;
                try {
                    const [bytes] = file.load_bytes_finish(result);
                    temperature = Number(new TextDecoder().decode(bytes.get_data()));
                } catch (error) {
                    if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    // INVALID_DATA is the EC reporting the sensor as failed, which stays the same as long as the
                    // failure does. Any other error is about reaching the file and says nothing about the sensor.
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.INVALID_DATA)) {
                        console.warn(`CPU Throttle Indicator: cannot read ${file.get_path()}: ${error.message}`);
                        return;
                    }
                }
                if (this._cancellable.is_cancelled() || temperature === sensor.temperature)
                    return;
                sensor.temperature = temperature;
                this._boardChangedAt = GLib.get_monotonic_time();
                this._boardStale = false;
            });
        }
    }

    /**
     * Updates the indicator and its menu from a reading and the reading before it.
     *
     * @param {object|null} metrics - the reading, or null when the table could not be decoded
     * @param {number} timestamp - the monotonic time in microseconds at which the reading was made
     */
    _update(metrics, timestamp) {
        // A table that cannot be decoded says nothing about whether anything is being held back, which is not the
        // same as saying that nothing is, so the indicator keeps showing its last state.
        if (!metrics)
            return;

        // A burst of load which ends before the board warms up rightly never starts the fan nor changes a board
        // reading, so a cool sample starts both counts over.
        const hot = metrics.temperatureCore >= FAN_NEEDED_ABOVE_C;
        this._samplesHot = hot ? this._samplesHot + 1 : 0;

        // A fan which the EC reports as stalled does not spin either, while one which has not been read yet counts as
        // spinning, so that nothing is reported before it is known.
        const fansOff = this._fanSpeedRows.length > 0 &&
            this._fanSpeedRows.every(row => row.speed === 0 || row.speed === null);
        if (!fansOff) {
            this._samplesFanOffWhileHot = 0;
        } else if (hot) {
            this._samplesFanOffWhileHot++;
        } else if (this._samplesFanOffWhileHot < FAULT_AFTER_HOT_SAMPLES) {
            // Once the warning is shown for this, it stays until a fan spins again, because fan control which stopped
            // reading its sensors does not recover as the processor cools down.
            this._samplesFanOffWhileHot = 0;
        }

        // The board readings are judged as soon as the processor has been hot for long enough, against the whole
        // BOARD_STALE_AFTER_S before, unless every fan target is at full speed. A target which has not been read yet
        // is not at full speed. Once the warning is shown for them, it stays until one of them changes, for the same
        // reason as for a fan which does not spin. A target which reaches full speed after that does not hide it,
        // because with the board readings unchanged, only the APU's own sensor can raise the target, which it does
        // only once the APU overheats.
        const fansAtFull = this._fanTargetRows.length > 0 &&
            this._fanTargetRows.every(row => row.speed >= FAN_FULL_TARGET_SHARE * FAN_MAX_RPM);
        if (this._samplesHot >= FAULT_AFTER_HOT_SAMPLES && !fansAtFull && this._boardChangedAt !== null &&
            timestamp - this._boardChangedAt >= BOARD_STALE_AFTER_S * GLib.USEC_PER_SEC)
            this._boardStale = true;

        const previous = this._previous;
        this._previous = {metrics, timestamp};
        // The counters are totals since boot, so a share of an interval needs the reading that bounds it.
        if (!previous)
            return;
        const elapsed = (timestamp - previous.timestamp) / 1000;
        if (elapsed <= 0)
            return;

        const shares = throttleShares(previous.metrics, metrics, elapsed);
        for (const reason of REASONS)
            this._shareLabels.get(reason.key).text = `${Math.round(shares[reason.key])}%`;
        // A group which is not working is slow because it has nothing to do, so reporting a share of its maximum
        // would say nothing about whether anything is holding it back.
        metrics.coreGroups.forEach((group, index) => {
            this._frequencyLabels[index].text = group.active
                ? formatFrequency(group.frequency, group.maxFrequency)
                : 'idle';
        });
        // The GPU and the NPU are slow when they have nothing to do, the same as a group of cores. The table has no busy
        // percentage for the memory, so its frequency is always shown.
        this._graphicsFrequencyLabel.text = metrics.graphicsActivity > 0
            ? formatFrequency(metrics.graphicsFrequency, this._clockLimits.graphics)
            : 'idle';
        this._npuFrequencyLabel.text = metrics.npuActivity > 0
            ? formatFrequency(metrics.npuFrequency, this._clockLimits.npu)
            : 'idle';
        this._memoryFrequencyLabel.text = formatFrequency(metrics.memoryFrequency, this._clockLimits.memory);
        this._graphicsUsageLabel.text = `${metrics.graphicsActivity}%`;
        this._npuUsageLabel.text = `${Math.round(metrics.npuActivity)}%`;

        // The table carries no temperature limits, so none of these temperatures is ever marked as critical.
        this._showTemperature(this._coreLabel, metrics.temperatureCore, false);
        this._showTemperature(this._gfxLabel, metrics.temperatureGfx, false);
        this._showTemperature(this._socLabel, metrics.temperatureSoc, false);

        this._systemPowerLabel.text = formatPower(metrics.systemPower);
        this._apuPowerLabel.text = formatPower(metrics.apuPower);
        this._corePowerLabel.text = formatPower(metrics.corePower);
        this._graphicsPowerLabel.text = formatPower(metrics.graphicsPower);
        this._npuPowerLabel.text = formatPower(metrics.npuPower);
        // The APU's power which neither the cores, the GPU nor the NPU draw is drawn by the rest of the chip, such as
        // the data fabric, the memory controller and its PHY, the display and media engines and the I/O. The cores'
        // power is the firmware's estimate, so the difference can come out slightly below zero while the rest of the
        // chip idles.
        this._socPowerLabel.text = formatPower(
            Math.max(0, metrics.apuPower - metrics.corePower - metrics.graphicsPower - metrics.npuPower));
        // The laptop's power which the APU does not draw is drawn by the display, the memory modules, the SSD, the
        // wireless card, the fan, the USB devices and the voltage regulators' losses.
        this._otherPowerLabel.text = formatPower(
            metrics.systemPower === null ? null : Math.max(0, metrics.systemPower - metrics.apuPower));

        const dominant = dominantReason(shares, THRESHOLD_PERCENT);
        if (dominant) {
            this._samplesUnderThreshold = 0;
            this._throttle = dominant;
        } else {
            this._samplesUnderThreshold++;
            if (this._samplesUnderThreshold >= HIDE_AFTER_SAMPLES)
                this._throttle = null;
        }
        this._render();
    }

    /**
     * Shows in the top bar what currently deserves attention, and hides the indicator when nothing does.
     */
    _render() {
        const fanFault = this._boardStale || this._samplesFanOffWhileHot >= FAULT_AFTER_HOT_SAMPLES;
        this._warningItem.visible = fanFault;
        // Without a fan which follows the heat the APU heats up until its temperature limit holds it back. The
        // indicator therefore shows that limit instead of the reason which holds the APU back right now.
        if (fanFault) {
            this._icon.gicon = this._icons.thermal;
            this._reasonLabel.text = 'THM';
            this.add_style_class_name(WARNING_PANEL_STYLE_CLASS);
            this.show();
            return;
        }
        this.remove_style_class_name(WARNING_PANEL_STYLE_CLASS);
        if (this._throttle) {
            this._icon.gicon = this._icons[this._throttle.kind];
            this._reasonLabel.text = this._throttle.short;
            this.show();
        } else if (this.visible) {
            this.menu.close();
            this.hide();
        }
    }
});

export default class CpuThrottleIndicatorExtension extends Extension {
    enable() {
        const file = findMetricsFile();
        // Without a table there is nothing this could ever report, so rather than sitting in the top bar saying
        // nothing it stays out of it and leaves a line in the journal saying why.
        if (!file) {
            console.warn(`${this.uuid}: no device publishes a metrics table this can read, not showing an indicator`);
            return;
        }
        // An embedded controller which does not report the APU temperature leaves the menu without it, and one which
        // reports no fan leaves the menu without its fans. The warning about the fan not following the heat then
        // rests on whichever of the fans and the board temperatures the EC does report. The menu lists the sensors of
        // the memory modules, the SSDs and the wireless cards this system has, numbered only when there are several
        // of a kind to tell apart.
        const named = (name, sensors) => sensors.map((sensor, index) => ({
            ...sensor,
            name: sensors.length === 1 ? name : `${name} ${index + 1}`,
        }));
        this._indicator = new Indicator(`${this.path}/icons`, {
            metricsFile: file,
            clockLimits: findClockLimits(file),
            fanFiles: findFanFiles(),
            boardSensorFiles: findBoardSensorFiles(),
            apuSensor: findApuSensor(),
            batteryFile: findBatteryFile(),
            temperatureSensors: [
                ...named('DRAM', findMemorySensors()),
                ...named('SSD', findSsdSensors()),
                ...named('Wi-Fi', findWifiSensors()),
            ],
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        // The indicator stays the first one on the right of the top bar. Indicators added after it are mostly added at
        // the start of that box as well, and AppIndicators adds the icons of applications at its second place, counting
        // indicators which are hidden. So without moving back to the start, whether the icons of applications end up
        // to the left or to the right of it would depend on the order in which extensions and applications started.
        const {container} = this._indicator;
        this._box = container.get_parent();
        this._box.connectObject('child-added', () => {
            if (container.get_previous_sibling())
                this._box.set_child_at_index(container, 0);
        }, this);
    }

    disable() {
        this._box?.disconnectObject(this);
        this._box = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
