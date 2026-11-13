import Gio from 'gi://Gio';

import {listChildren, readText} from './hwmon.js';

/**
 * Finds the file through which the kernel reports the state of the battery which powers the system.
 *
 * The file is the battery's uevent attribute, which holds one property per line, as POWER_SUPPLY_<NAME>=<value>.
 *
 * @returns {Gio.File|null} the file, or null when the system has no such battery
 */
export function findBatteryFile() {
    for (const name of listChildren('/sys/class/power_supply')) {
        const directory = `/sys/class/power_supply/${name}`;
        // The battery of a device, such as a mouse, has the scope Device, while the one which powers the system has
        // the scope System or none at all.
        if (readText(`${directory}/type`) === 'Battery' && readText(`${directory}/scope`) !== 'Device')
            return Gio.File.new_for_path(`${directory}/uevent`);
    }
    return null;
}

/**
 * Decodes the power which charges the battery.
 *
 * @param {Uint8Array} bytes - the contents of the file findBatteryFile returned
 * @returns {number|null} the power in watts, or null when the battery is not charging or reports neither its power nor
 *   its current and voltage
 */
export function decodeChargingPower(bytes) {
    const properties = new Map();
    for (const line of new TextDecoder().decode(bytes).split('\n')) {
        const match = /^POWER_SUPPLY_([A-Z_]+)=(.*)$/.exec(line);
        if (match)
            properties.set(match[1], match[2]);
    }
    if (properties.get('STATUS') !== 'Charging')
        return null;
    // A battery which counts its charge in watt hours reports its power, and one which counts it in ampere hours, as
    // the battery of this laptop does, reports its current and voltage instead, each in millionths of its unit. Some
    // drivers report the current of a charging battery as negative.
    if (properties.has('POWER_NOW'))
        return Math.abs(Number(properties.get('POWER_NOW'))) / 1e6;
    if (properties.has('CURRENT_NOW') && properties.has('VOLTAGE_NOW'))
        return Math.abs(Number(properties.get('CURRENT_NOW'))) * Number(properties.get('VOLTAGE_NOW')) / 1e12;
    return null;
}
