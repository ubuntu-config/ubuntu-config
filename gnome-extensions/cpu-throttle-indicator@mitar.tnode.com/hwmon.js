import Gio from 'gi://Gio';

/**
 * Finds the temperature sensors of the memory modules.
 *
 * These are the sensors of the SPD hubs of DDR5 modules, which the spd5118 driver reads over SMBus. Each file holds the
 * temperature in millidegrees Celsius.
 *
 * @returns {{file: Gio.File, critical: number|null}[]} the sensors in the order of their SMBus addresses, which is the
 *   order of the memory slots, each with its critical limit in degrees Celsius or null when it reports none, or an
 *   empty array when there is no such sensor
 */
export function findMemorySensors() {
    return findSensors(directory => readText(`${directory}/name`) === 'spd5118');
}

/**
 * Finds the temperature sensors of the NVMe drives.
 *
 * Each sensor is the composite temperature of a drive, the one against which the drive applies its own warning and
 * critical limits. Every read of the file sends a command to the drive, which wakes it from a power saving state. The
 * file holds the temperature in millidegrees Celsius.
 *
 * @returns {{file: Gio.File, critical: number|null}[]} the sensors in the order of the drives' names, each with its
 *   critical limit in degrees Celsius or null when it reports none, or an empty array when there is no such sensor
 */
export function findSsdSensors() {
    return findSensors(directory => readText(`${directory}/name`) === 'nvme', 'Composite');
}

/**
 * Finds the temperature sensors of the wireless network cards.
 *
 * These are the sensors which a driver registers on the card's wireless device, as mt76 and ath11k do. Every read of
 * the file sends a command to the card's firmware, which wakes the card from a power saving state. The file holds the
 * temperature in millidegrees Celsius.
 *
 * @returns {{file: Gio.File, critical: number|null}[]} the sensors in the order of the wireless devices' names, each
 *   with its critical limit in degrees Celsius or null when it reports none, or an empty array when there is no such
 *   sensor
 */
export function findWifiSensors() {
    return findSensors(directory => linkName(`${directory}/device/subsystem`) === 'ieee80211');
}

/**
 * Finds the temperature sensor of each hwmon device which matches.
 *
 * @param {Function} matches - called with the sysfs directory of a hwmon device, returns whether it is wanted
 * @param {string} [label] - the label of the sensor to use on a device with several of them, which falls back to its
 *   first sensor when none carries the label
 * @returns {{file: Gio.File, critical: number|null}[]} the sensors in the order of the names of their devices
 */
function findSensors(matches, label) {
    const sensors = [];
    for (const directory of listHwmonDirectories().filter(matches)) {
        const names = listChildren(directory);
        let sensor = 'temp1';
        if (label) {
            for (const name of names) {
                const match = /^(temp\d+)_label$/.exec(name);
                if (match && readText(`${directory}/${name}`) === label)
                    sensor = match[1];
            }
        }
        if (!names.includes(`${sensor}_input`))
            continue;
        const critical = Number.parseInt(readText(`${directory}/${sensor}_crit`), 10);
        sensors.push({
            device: linkName(`${directory}/device`) ?? '',
            file: Gio.File.new_for_path(`${directory}/${sensor}_input`),
            critical: Number.isNaN(critical) ? null : critical / 1000,
        });
    }
    // The index of a hwmon device depends on the order the drivers came up, so the devices are ordered by their own
    // names, such as 3-0050 for the module at SMBus address 0x50 of bus 3 or nvme0 for the first NVMe drive.
    sensors.sort((a, b) => a.device.localeCompare(b.device, undefined, {numeric: true}));
    return sensors.map(({file, critical}) => ({file, critical}));
}

/**
 * Finds the hwmon devices a driver registered under a name.
 *
 * @param {string} name - the name the driver gives its hwmon devices
 * @returns {string[]} the sysfs directories of the devices
 */
export function findHwmonDirectories(name) {
    // The index of a hwmon device depends on the order the drivers came up, so it is not stable across boots, and
    // a device is found by its name instead.
    return listHwmonDirectories().filter(directory => readText(`${directory}/name`) === name);
}

/**
 * Lists the hwmon devices.
 *
 * @returns {string[]} the sysfs directories of the devices
 */
function listHwmonDirectories() {
    return listChildren('/sys/class/hwmon').map(device => `/sys/class/hwmon/${device}`);
}

/**
 * Lists the names of the entries of a directory.
 *
 * @param {string} path - the directory
 * @returns {string[]} the names, or an empty array when the directory cannot be listed
 */
export function listChildren(path) {
    const names = [];
    try {
        const children = Gio.File.new_for_path(path).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE,
            null);
        let child;
        while ((child = children.next_file(null)) !== null)
            names.push(child.get_name());
        children.close(null);
    } catch {
        // A system without the directory, where there is nothing to find.
    }
    return names;
}

/**
 * Reads a sysfs attribute which holds a line of text.
 *
 * @param {string} path - the attribute
 * @returns {string|null} the text without its trailing newline, or null when the attribute cannot be read
 */
export function readText(path) {
    try {
        const [, contents] = Gio.File.new_for_path(path).load_contents(null);
        return new TextDecoder().decode(contents).trim();
    } catch {
        return null;
    }
}

/**
 * Reads the last component of the target of a symbolic link, which in sysfs names the device or the subsystem the
 * link points to.
 *
 * @param {string} path - the link
 * @returns {string|null} the name, or null when the path is not a link which can be read
 */
function linkName(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        return info.get_symlink_target()?.split('/').pop() ?? null;
    } catch {
        return null;
    }
}
