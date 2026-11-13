import Gio from 'gi://Gio';

import {findHwmonDirectories, listChildren, readText} from './hwmon.js';

// The hwmon device the cros_ec driver registers for the embedded controller, and the label Framework's EC gives the
// sensor through which it reads the APU's own temperature over SB-TSI. The EC runs the fan from its sensors, and this
// is the only one of them which follows the APU rather than the board around it.
const HWMON_NAME = 'cros_ec';
const APU_SENSOR_LABEL = 'cpu@4c';

/**
 * The top of the embedded controller's fan table, in RPM.
 *
 * The EC does not report it, so the value comes from the EC's source code, the rpm_max of the fan which Framework sets
 * in zephyr/program/framework/azalea/fan.dtsi of https://github.com/FrameworkComputer/EmbeddedController (branch
 * fwk-lilac-27116). The EC of this laptop is built as the lilac variant of azalea, without any board code which would
 * change the limit at runtime, so this is the fastest the EC's automatic control runs the fan. Under manual control of
 * its duty cycle the fan can spin faster, up to about 7600 RPM at a full duty cycle. The _FPS table of the firmware's
 * ACPI fan declares 6100 RPM as the fan's full speed.
 */
export const FAN_MAX_RPM = 6200;

/**
 * Finds the file through which the embedded controller reports the temperature it reads from the APU.
 *
 * The file holds the temperature in millidegrees Celsius. Reading it fails with Gio.IOErrorEnum.INVALID_DATA while the
 * EC cannot read the sensor, because the driver answers every error state the EC reports for a sensor with ENODATA.
 *
 * The critical limit is the sensor's EC_TEMP_THRESH_HIGH threshold, at which the EC throttles the APU.
 *
 * @returns {{file: Gio.File, critical: number|null}|null} the file with the critical limit in degrees Celsius, or
 *   null for the limit when the EC reports none, or null when no embedded controller on this system reports such a
 *   sensor
 */
export function findApuSensor() {
    // The index of a sensor is the EC's own numbering, so the sensor is found by its label.
    for (const directory of findHwmonDirectories(HWMON_NAME)) {
        for (const name of listChildren(directory)) {
            const match = /^(temp\d+)_label$/.exec(name);
            if (match && readText(`${directory}/${name}`) === APU_SENSOR_LABEL) {
                const critical = Number.parseInt(readText(`${directory}/${match[1]}_crit`), 10);
                return {
                    file: Gio.File.new_for_path(`${directory}/${match[1]}_input`),
                    critical: Number.isNaN(critical) ? null : critical / 1000,
                };
            }
        }
    }
    return null;
}

/**
 * Finds the files through which the embedded controller reports the temperatures on the board, which it runs the fan
 * from.
 *
 * These are all of the EC's temperature sensors other than the one it reads from the APU. Each file holds the
 * temperature in millidegrees Celsius, in whole degrees. Reading it fails with Gio.IOErrorEnum.INVALID_DATA while the
 * EC reports the sensor as failed, but Framework's EC does not report a board sensor it cannot read any more as
 * failed. It keeps reporting the last temperature it read from it, so that shows only as a reading which stops
 * changing.
 *
 * @returns {Gio.File[]} the files, or an empty array when no embedded controller on this system reports such a sensor
 */
export function findBoardSensorFiles() {
    const files = [];
    for (const directory of findHwmonDirectories(HWMON_NAME)) {
        for (const name of listChildren(directory)) {
            const match = /^(temp\d+)_label$/.exec(name);
            if (match && readText(`${directory}/${name}`) !== APU_SENSOR_LABEL)
                files.push(Gio.File.new_for_path(`${directory}/${match[1]}_input`));
        }
    }
    return files;
}

/**
 * Finds the files through which the embedded controller reports the speed of each of its fans.
 *
 * Each file holds the speed in RPM. The driver lists only the fans the EC reported as present when the driver came up,
 * and reading the file of one of them fails with Gio.IOErrorEnum.INVALID_DATA while the EC reports that fan as
 * stalled, because the driver answers that with ENODATA.
 *
 * The target file of a fan holds the speed in RPM the EC's control is bringing the fan to, which is 0 while the fan is
 * off. Under manual control of the fan's duty cycle the EC does not update the target, which then keeps the last one
 * its automatic control set. The EC reports a target only for its first fan, because the command for it carries no fan
 * index. Reading the file fails with an error for any failure of that command, and Gio.IOErrorEnum.INVALID_DATA there
 * means that the EC could not answer, not that the fan is stalled.
 *
 * @returns {{number: number, file: Gio.File, targetFile: Gio.File|null}[]} the fans in the order of the EC's own
 *   numbering of them, which starts at 1, with targetFile null for a fan without a target, or an empty array when no
 *   embedded controller on this system reports a fan
 */
export function findFanFiles() {
    const fans = [];
    for (const directory of findHwmonDirectories(HWMON_NAME)) {
        const names = listChildren(directory);
        for (const name of names) {
            const match = /^fan(\d+)_input$/.exec(name);
            if (!match)
                continue;
            const target = `fan${match[1]}_target`;
            fans.push({
                number: Number(match[1]),
                file: Gio.File.new_for_path(`${directory}/${name}`),
                targetFile: names.includes(target) ? Gio.File.new_for_path(`${directory}/${target}`) : null,
            });
        }
    }
    // A directory lists its entries in no particular order.
    return fans.sort((a, b) => a.number - b.number);
}
