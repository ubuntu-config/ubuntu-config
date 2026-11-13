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
    CORE_GROUPS, REASONS, decodeMetrics, dominantReason, findClockLimits, findGroupCpus, findMetricsFile,
    throttleShares, unwrapDramBandwidth,
} from './metrics.js';

const SAMPLE_INTERVAL_S = 2;

// The file in which the kernel adds up the time each logical CPU spent in each state since boot.
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

// The style classes of the background and of the labels of a menu row which shows a critical temperature.
const CRITICAL_ROW_STYLE_CLASS = 'cpu-throttle-indicator-critical';
const CRITICAL_TEXT_STYLE_CLASS = 'cpu-throttle-indicator-critical-text';

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
 * Formats a bandwidth for the menu.
 *
 * @param {number} bandwidth - the bandwidth in MB/s
 * @param {number|null} maxBandwidth - the bandwidth in MB/s reached when nothing holds it back, or null when unknown
 * @returns {string} the bandwidth, with its share of the maximum when that is known
 */
function formatBandwidth(bandwidth, maxBandwidth) {
    const text = `${(bandwidth / 1000).toFixed(1)} GB/s`;
    return maxBandwidth ? `${text}, ${Math.round(100 * bandwidth / maxBandwidth)}%` : text;
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
     * @param {Set<number>[]} devices.groupCpus - the logical CPUs of each group of cores, as findGroupCpus returned
     *   them
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
        metricsFile, clockLimits, groupCpus, fanFiles, boardSensorFiles, apuSensor, batteryFile, temperatureSensors,
    }) {
        super._init(0, 'CPU Throttle Indicator');

        this._file = metricsFile;
        this._clockLimits = clockLimits;
        this._cpuTimesFile = Gio.File.new_for_path(CPU_TIMES_PATH);
        this._groupCpus = groupCpus;
        this._batteryFile = batteryFile;
        this._readingBattery = false;
        this._cancellable = new Gio.Cancellable();
        this._previous = null;
        this._reading = false;
        this._readingCpuTimes = false;
        // The total and the idle time of the logical CPUs of each group of cores at the last reading, in the kernel's
        // clock ticks.
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

        // The limits are in two columns, the temperature limits on the left with the platform's PROCHOT under them,
        // and the power limits on the right.
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Limits'));
        const limits = this._addGrid();
        const ofKind = kind => REASONS.filter(reason => reason.kind === kind);
        const limitColumns = [[...ofKind('thermal'), ...ofKind('platform')], ofKind('power')];
        this._shareLabels = new Map();
        limitColumns.forEach((reasons, column) => reasons.forEach((reason, row) => {
            const [label] = this._addGridRow(limits, row, 2 * column, reason.label, 1);
            this._shareLabels.set(reason.key, label);
        }));

        // The usage and the frequency of each part are in a column each, with a heading which names the columns.
        // A line fills the room left of each name in the heading, as in the heading of a section. The line before the
        // first name and that name share a cell spanning the column of the row names, so that the line also runs over
        // the room the values of the first column leave free.
        const clocks = this._addGrid();
        const usageHeading = new St.BoxLayout({style_class: 'cpu-throttle-indicator-heading', x_expand: true});
        usageHeading.add_child(this._createHeadingLine());
        usageHeading.add_child(new St.Label({text: 'Usage', style_class: 'cpu-throttle-indicator-column-name'}));
        clocks.attach(usageHeading, 0, 0, 2, 1);
        const frequencyHeading = new St.BoxLayout({style_class: 'cpu-throttle-indicator-grid-heading', x_expand: true});
        frequencyHeading.add_child(this._createHeadingLine());
        frequencyHeading.add_child(new St.Label({text: 'Frequency'}));
        clocks.attach(frequencyHeading, 2, 0, 1, 1);
        const clockRows = [...CORE_GROUPS.map(group => `${group.name} cores`), 'GPU', 'NPU', 'DRAM']
            .map((name, index) => this._addGridRow(clocks, index + 1, 0, name, 2));
        this._usageLabels = clockRows.slice(0, CORE_GROUPS.length).map(([usage]) => usage);
        this._frequencyLabels = clockRows.slice(0, CORE_GROUPS.length).map(([, frequency]) => frequency);
        [[this._graphicsUsageLabel, this._graphicsFrequencyLabel], [this._npuUsageLabel, this._npuFrequencyLabel],
            [this._memoryUsageLabel, this._memoryFrequencyLabel]] = clockRows.slice(CORE_GROUPS.length);
        // The fans have a column for their speed and one for their target, with a heading which names the section and
        // the columns.
        const fans = fanFiles.length ? this._addGrid() : null;
        if (fans) {
            // The name of the section and the name of the first column share a cell, so that the line between them
            // runs over the room the values of the first column leave free.
            const sectionHeading = new St.BoxLayout({style_class: 'cpu-throttle-indicator-heading', x_expand: true});
            sectionHeading.add_child(new St.Label({text: 'Fans'}));
            sectionHeading.add_child(this._createHeadingLine());
            sectionHeading.add_child(new St.Label({text: 'Speed', style_class: 'cpu-throttle-indicator-column-name'}));
            fans.attach(sectionHeading, 0, 0, 2, 1);
            const targetHeading = new St.BoxLayout({
                style_class: 'cpu-throttle-indicator-grid-heading',
                x_expand: true,
            });
            targetHeading.add_child(this._createHeadingLine());
            targetHeading.add_child(new St.Label({text: 'Target'}));
            fans.attach(targetHeading, 2, 0, 1, 1);
        }
        // Each entry shows one file, either the speed of a fan or its target.
        this._fanRows = [];
        fanFiles.forEach((fan, index) => {
            // A single fan is the one which cools the APU, and several are numbered to tell them apart.
            const name = fanFiles.length === 1 ? 'APU' : `Fan ${fan.number}`;
            const [speedLabel, targetLabel] = this._addGridRow(fans, index + 1, 0, name, 2);
            this._fanRows.push({
                kind: 'speed',
                file: fan.file,
                label: speedLabel,
                reading: false,
                // Undefined until the fan has been read, and null while the EC reports the fan as stalled.
                speed: undefined,
            });
            if (fan.targetFile) {
                this._fanRows.push({
                    kind: 'target',
                    file: fan.targetFile,
                    label: targetLabel,
                    reading: false,
                    // Undefined until the target has been read.
                    speed: undefined,
                });
            }
        });
        this._fanSpeedRows = this._fanRows.filter(row => row.kind === 'speed');
        this._fanTargetRows = this._fanRows.filter(row => row.kind === 'target');
        // The temperature and the power of each part are in a column each, with a heading which names the columns.
        const parts = this._addGrid(true);
        const temperatureLine = this._createHeadingLine();
        temperatureLine.add_style_class_name('cpu-throttle-indicator-cell');
        parts.attach(temperatureLine, 0, 0, 1, 1);
        parts.attach(new St.Label({
            text: 'Temperature',
            style_class: 'cpu-throttle-indicator-cell',
            x_align: Clutter.ActorAlign.END,
        }), 1, 0, 1, 1);
        const powerHeading = new St.BoxLayout({
            style_class: 'cpu-throttle-indicator-grid-heading cpu-throttle-indicator-cell',
            x_expand: true,
        });
        powerHeading.add_child(this._createHeadingLine());
        powerHeading.add_child(new St.Label({text: 'Power'}));
        parts.attach(powerHeading, 2, 0, 1, 1);
        // The laptop's power is the APU's and the other power together, and the APU's is its four parts together,
        // which are indented under it. The power which charges the battery is not part of the laptop's, and its row
        // is shown only while the battery charges. The memory modules, the SSD and the wireless card draw a part of
        // the other power, and are indented under it.
        let rows = 0;
        const addPart = (name, indented = false) => this._addPartRow(parts, ++rows, name, indented);
        this._laptopRow = addPart('Laptop');
        this._apuRow = addPart('APU');
        this._cpuRow = addPart('CPU', true);
        this._gpuRow = addPart('GPU', true);
        this._npuRow = addPart('NPU', true);
        this._socRow = addPart('SoC', true);
        this._batteryRow = addPart('Battery');
        this._setRowVisible(this._batteryRow, false);
        this._otherRow = addPart('Other');
        const addSensor = (sensor, row) => ({file: sensor.file, critical: sensor.critical, row, reading: false});
        this._temperatureSensors = [
            ...(apuSensor ? [addSensor(apuSensor, this._apuRow)] : []),
            ...temperatureSensors.map(sensor => addSensor(sensor, addPart(sensor.name, true))),
        ];

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
     * Adds a grid to the menu, for rows whose columns line up.
     *
     * @param {boolean} [markable] - whether rows of the grid can be marked as critical, for which every child of the
     *   grid has to have the style class cpu-throttle-indicator-cell
     * @returns {Clutter.GridLayout} the layout of the grid, to attach labels to
     */
    _addGrid(markable = false) {
        // The theme clears the background of a menu item which does not react to the pointer, so the background which
        // marks a row is a child of the grid of its own.
        const item = new PopupMenu.PopupBaseMenuItem({
            style_class: markable ? 'cpu-throttle-indicator-markable-item' : '',
            reactive: false,
            can_focus: false,
        });
        const layout = new Clutter.GridLayout();
        const grid = new St.Widget({
            style_class: markable ? 'cpu-throttle-indicator-grid cpu-throttle-indicator-markable-grid'
                : 'cpu-throttle-indicator-grid',
            layout_manager: layout,
            x_expand: true,
        });
        // GNOME Shell sets the spacing of a grid from its style only once the layout is hooked up to the widget.
        layout.hookup_style(grid);
        item.add_child(grid);
        this.menu.addMenuItem(item);
        return layout;
    }

    /**
     * Creates a line as the theme draws it in the heading of a section.
     *
     * @returns {St.Widget} the line, which fills the room it is given
     */
    _createHeadingLine() {
        // The theme styles the line only inside a heading, which the bin around it stands for.
        return new St.Bin({
            style_class: 'popup-separator-menu-item',
            x_expand: true,
            child: new St.Widget({
                style_class: 'popup-separator-menu-item-separator',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
    }

    /**
     * Adds a name and the labels of its values to a row of a grid.
     *
     * @param {Clutter.GridLayout} layout - the layout _addGrid returned
     * @param {number} row - the row of the grid
     * @param {number} column - the column of the name, with the values in the columns right of it
     * @param {string} text - the name
     * @param {number} values - the number of values
     * @returns {St.Label[]} the labels of the values, to set the values on
     */
    _addGridRow(layout, row, column, text, values) {
        // A name right of other columns has room between it and the value left of it.
        layout.attach(new St.Label({
            text,
            style_class: column > 0 ? 'cpu-throttle-indicator-grid-inner-name' : '',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }), column, row, 1, 1);
        const labels = [];
        for (let index = 1; index <= values; index++) {
            const label = new St.Label({x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
            layout.attach(label, column + index, row, 1, 1);
            labels.push(label);
        }
        return labels;
    }

    /**
     * Adds a part of the laptop to a row of the grid of temperatures and power.
     *
     * @param {Clutter.GridLayout} layout - the layout _addGrid returned for a grid whose rows can be marked
     * @param {number} row - the row of the grid
     * @param {string} text - the name of the part
     * @param {boolean} indented - whether the name is indented, as a part of the part above
     * @returns {{background: St.Widget, labels: St.Label[], temperature: St.Label, power: St.Label}} the row, with the
     *   labels of its temperature and its power to set them on
     */
    _addPartRow(layout, row, text, indented) {
        // The background spans the row behind its labels, which are added after it.
        const background = new St.Widget({style_class: 'cpu-throttle-indicator-row-background'});
        layout.attach(background, 0, row, 3, 1);
        const name = new St.Label({
            text,
            style_class: indented ? 'cpu-throttle-indicator-cell cpu-throttle-indicator-indented'
                : 'cpu-throttle-indicator-cell',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        layout.attach(name, 0, row, 1, 1);
        const [temperature, power] = [1, 2].map(column => {
            const label = new St.Label({
                style_class: 'cpu-throttle-indicator-cell',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            layout.attach(label, column, row, 1, 1);
            return label;
        });
        return {background, labels: [name, temperature, power], temperature, power};
    }

    /**
     * Shows or hides a row of the grid of temperatures and power.
     *
     * @param {object} row - the row _addPartRow returned
     * @param {boolean} visible - whether the row is shown
     */
    _setRowVisible(row, visible) {
        for (const actor of [row.background, ...row.labels])
            actor.visible = visible;
    }

    /**
     * Shows a temperature in a row of the grid of temperatures and power, and marks the row while the temperature is
     * critical.
     *
     * @param {object} row - the row _addPartRow returned
     * @param {number|null} temperature - the temperature in degrees Celsius, or null when the sensor cannot be read
     * @param {boolean} critical - whether the temperature is critical
     */
    _showTemperature(row, temperature, critical) {
        row.temperature.text = temperature === null ? 'error' : `${temperature.toFixed(1)} C`;
        if (critical)
            row.background.add_style_class_name(CRITICAL_ROW_STYLE_CLASS);
        else
            row.background.remove_style_class_name(CRITICAL_ROW_STYLE_CLASS);
        for (const label of row.labels) {
            if (critical)
                label.add_style_class_name(CRITICAL_TEXT_STYLE_CLASS);
            else
                label.remove_style_class_name(CRITICAL_TEXT_STYLE_CLASS);
        }
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
            // Each line "cpu<N>" holds the times of one logical CPU, as the time spent in user, nice, system, idle,
            // iowait, irq, softirq and steal, and then in guest and guest_nice, which user and nice include already. A
            // CPU waiting for I/O is idle.
            const times = this._groupCpus.map(() => ({total: 0, idle: 0}));
            for (const line of new TextDecoder().decode(bytes.get_data()).split('\n')) {
                const match = /^cpu(\d+)\s+(.*)$/.exec(line);
                const group = match ? this._groupCpus.findIndex(cpus => cpus.has(Number(match[1]))) : -1;
                if (group < 0)
                    continue;
                const fields = match[2].trim().split(/\s+/).slice(0, 8).map(Number);
                times[group].total += fields.reduce((sum, time) => sum + time, 0);
                times[group].idle += fields[3] + fields[4];
            }
            const previous = this._cpuTimes;
            this._cpuTimes = times;
            if (!previous)
                return;
            // A CPU taken offline leaves the totals of its group, which can then fall below the last reading.
            times.forEach((current, group) => {
                const elapsed = current.total - previous[group].total;
                if (elapsed > 0) {
                    const busy = 1 - (current.idle - previous[group].idle) / elapsed;
                    this._usageLabels[group].text = `${Math.round(100 * busy)}%`;
                }
            });
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
            this._setRowVisible(this._batteryRow, power !== null);
            if (power !== null)
                this._batteryRow.power.text = formatPower(power);
        });
    }

    _sampleTemperatures() {
        // Each file is read off the main loop and one read at a time, the same as the metrics table.
        for (const sensor of this._temperatureSensors) {
            if (sensor.reading)
                continue;
            sensor.reading = true;
            sensor.file.load_bytes_async(this._cancellable, (file, result) => {
                sensor.reading = false;
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
                    this._showTemperature(sensor.row, temperature,
                        sensor.critical !== null && temperature !== null && temperature >= sensor.critical);
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
        metrics.coreGroups.forEach((group, index) => {
            this._frequencyLabels[index].text = formatFrequency(group.frequency, group.maxFrequency);
        });
        this._graphicsFrequencyLabel.text = formatFrequency(metrics.graphicsFrequency, this._clockLimits.graphics);
        this._npuFrequencyLabel.text = formatFrequency(metrics.npuFrequency, this._clockLimits.npu);
        this._memoryFrequencyLabel.text = formatFrequency(metrics.memoryFrequency, this._clockLimits.memory);
        this._graphicsUsageLabel.text = `${metrics.graphicsActivity}%`;
        this._npuUsageLabel.text = `${Math.round(metrics.npuActivity)}%`;
        // The usage of the memory is the bandwidth of its reads and writes together.
        unwrapDramBandwidth(previous.metrics, metrics, elapsed);
        this._memoryUsageLabel.text = formatBandwidth(metrics.dramReads + metrics.dramWrites,
            this._clockLimits.memoryBandwidth);

        // The table carries no temperature limits, so none of these temperatures is ever marked as critical. The
        // laptop's temperature is the skin temperature, which AMD's firmware interface describes as the highest skin
        // temperature the APU and the sensors on the chassis report.
        this._showTemperature(this._laptopRow, metrics.temperatureSkin, false);
        this._showTemperature(this._cpuRow, metrics.temperatureCore, false);
        this._showTemperature(this._gpuRow, metrics.temperatureGfx, false);
        this._showTemperature(this._socRow, metrics.temperatureSoc, false);

        this._laptopRow.power.text = formatPower(metrics.systemPower);
        this._apuRow.power.text = formatPower(metrics.apuPower);
        this._cpuRow.power.text = formatPower(metrics.corePower);
        this._gpuRow.power.text = formatPower(metrics.graphicsPower);
        this._npuRow.power.text = formatPower(metrics.npuPower);
        // The APU's power which neither the cores, the GPU nor the NPU draw is drawn by the rest of the chip, such as
        // the data fabric, the memory controller and its PHY, the display and media engines and the I/O. The cores'
        // power is the firmware's estimate, so the difference can come out slightly below zero while the rest of the
        // chip idles.
        this._socRow.power.text = formatPower(
            Math.max(0, metrics.apuPower - metrics.corePower - metrics.graphicsPower - metrics.npuPower));
        // The laptop's power which the APU does not draw is drawn by the display, the memory modules, the SSD, the
        // wireless card, the fan, the USB devices and the voltage regulators' losses.
        this._otherRow.power.text = formatPower(
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
            groupCpus: findGroupCpus(),
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
