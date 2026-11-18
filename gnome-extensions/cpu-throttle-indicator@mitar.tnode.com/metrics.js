import Gio from 'gi://Gio';

import {listChildren, readText} from './hwmon.js';

// The fields below come from struct gpu_metrics_v3_0 in drivers/gpu/drm/amd/include/kgd_pp_interface.h, at the
// offsets the kernel compiles that struct to with its natural alignment. amdgpu publishes the struct as a whole and
// describes it only by the revision and size in its header, so a field is read from a fixed offset once the
// header says the layout is the one these offsets belong to.
const STRUCTURE_SIZE = 264;
const FORMAT_REVISION = 3;

const OFFSET_STRUCTURE_SIZE = 0;
const OFFSET_FORMAT_REVISION = 2;
const OFFSET_TEMPERATURE_GFX = 4;
const OFFSET_TEMPERATURE_SOC = 6;
const OFFSET_TEMPERATURE_CORE = 8;
const OFFSET_TEMPERATURE_SKIN = 40;
const OFFSET_AVERAGE_GFX_ACTIVITY = 42;
const OFFSET_AVERAGE_IPU_ACTIVITY = 46;
const OFFSET_AVERAGE_DRAM_READS = 94;
const OFFSET_AVERAGE_DRAM_WRITES = 96;
const OFFSET_AVERAGE_IPU_POWER = 116;
const OFFSET_AVERAGE_APU_POWER = 120;
const OFFSET_AVERAGE_GFX_POWER = 124;
const OFFSET_AVERAGE_ALL_CORE_POWER = 132;
const OFFSET_AVERAGE_CORE_POWER = 136;
const OFFSET_AVERAGE_SYS_POWER = 168;
const OFFSET_AVERAGE_GFXCLK_FREQUENCY = 174;
const OFFSET_AVERAGE_IPUCLK_FREQUENCY = 180;
const OFFSET_AVERAGE_UCLK_FREQUENCY = 186;
const OFFSET_CURRENT_CORECLK = 190;

// The NPU's columns, each of which has an entry in average_ipu_activity.
const NPU_COLUMNS = 8;

/**
 * The frequency of the NPU's array of AI engines when nothing holds it back, in MHz.
 *
 * amdgpu does not publish the NPU's clock levels, so the value comes from the kernel's amdxdna driver, the H clock of
 * the top level of npu4_dpm_clk_table in drivers/accel/amdxdna/npu4_regs.c, which the driver uses for the NPU of
 * Strix Point. average_ipuclk_frequency follows that clock: with the NPU awake at the driver's default power mode, it
 * settled at 1152 MHz while average_mpipu_frequency settled at 798 MHz, the H clock and the MP-NPU clock of one level
 * of the table.
 */
const NPU_MAX_FREQUENCY = 1800;

// The topology amdkfd, the compute part of amdgpu, publishes: a node per CPU and per GPU, each with its memory banks.
const KFD_NODES_PATH = '/sys/class/kfd/kfd/topology/nodes';

// The DRAM bandwidth is in 16 bit fields of MB/s, which wrap at this.
const DRAM_BANDWIDTH_WRAP = 65536;

/**
 * Where each core sits in the per-core arrays, and the frequency it reaches when nothing holds it back.
 *
 * The table carries no mapping of its own, so this was measured by pinning a load to one core at a time and
 * watching which entry of average_core_power responded: on this processor the four classic cores occupy the even
 * entries 0 to 6 and the eight dense cores the entries 8 to 15, leaving 1, 3, 5 and 7 unused. A processor with a
 * different split may lay them out differently, and its groups then read the entries of other cores or unused ones.
 */
export const CORE_GROUPS = [
    {name: 'Zen 5', slots: [0, 2, 4, 6], maxFrequency: 5157},
    {name: 'Zen 5c', slots: [8, 9, 10, 11, 12, 13, 14, 15], maxFrequency: 3289},
];

// The table marks a field as carrying nothing, for entries the firmware leaves out, by setting it to the largest
// value it can hold.
const UNSET_UINT16 = 0xffff;

// Counters wrap at the range of the unsigned 32 bit fields that hold them, after about 49.7 days of uptime.
const COUNTER_MODULUS = 2 ** 32;

// The highest sustained power limit (SPL) in watts in any power table of the embedded controller of this laptop.
// Framework sets the tables in zephyr/program/framework/azalea/src/pmf.c of its EmbeddedController repository, which
// builds the EC of the Laptop 13 (AMD Ryzen AI 300 Series) as its lilac variant: 30 W for best performance, 25 W for
// balanced and 15 W for best power efficiency, on AC power and on battery. The EC's other adjustments of the limits,
// on battery and at a thermal warning, only lower them.
const SUSTAINED_LIMIT_CEILING_W = 30;

// The APU's power is averaged over this many seconds before it is compared, so that its short bursts above its limits
// do not count.
const OVER_LIMIT_AVERAGE_S = 60;

// The average power above which the APU counts as drawing more than any sustained limit the EC sets. Held at the 30 W
// limit under a steady load, the APU's average power stayed at 31.1 W or below in the daily health benchmark. With
// the EC's limits not reaching it, the APU ran at its slow power limit instead: 33 W on balanced and 35 W on best
// performance.
const OVER_LIMIT_POWER_W = SUSTAINED_LIMIT_CEILING_W + 2;

// How long the average power has to stay above OVER_LIMIT_POWER_W before the EC's limits count as not reaching the APU.
// Every load starts at the slow power limit, which holds until the running average the sustained limit tracks has
// risen to that limit. Under the daily health benchmark's steady load on best performance, the average stayed above
// OVER_LIMIT_POWER_W for at most 301 seconds. With the EC's limits not reaching the APU, it stayed above for as long as
// the load lasted, 10 minutes in each of the two loads measured.
const OVER_LIMIT_FOR_S = 15 * 60;

// The share of the time over OVER_LIMIT_AVERAGE_S in which the sustained limit has to hold the APU back, with the
// average power at or below OVER_LIMIT_POWER_W, for the EC's limits to count as reaching the APU again.
const SUSTAINED_LIMIT_HOLDING_PERCENT = 50;

// A longer gap between two samples, in seconds, leaves the average unknown for that time, so the check starts over.
const SAMPLE_GAP_S = 10;

/**
 * The reasons the processor can be held below the speed it would otherwise run at, in the order the kernel declares
 * their counters. SPL is the sustained power limit, and FPPT and SPPT the fast and slow package power tracking
 * limits, which together keep the package within its power budget over different time scales. The THM reasons are
 * the temperature limits of the individual domains. PROCHOT is asserted by the platform rather than by the
 * processor, and the platform does not report its cause, so it is its own kind.
 *
 * Each entry carries the offset of its throttle_residency_ field, which counts the milliseconds the processor has
 * spent limited by that reason since boot.
 */
export const REASONS = [
    {key: 'prochot', offset: 228, short: 'PROCHOT', label: 'Platform (PROCHOT)', kind: 'platform'},
    {key: 'spl', offset: 232, short: 'SPL', label: 'Sustained power (SPL)', kind: 'power'},
    {key: 'fppt', offset: 236, short: 'FPPT', label: 'Fast power (FPPT)', kind: 'power'},
    {key: 'sppt', offset: 240, short: 'SPPT', label: 'Slow power (SPPT)', kind: 'power'},
    {key: 'thm_core', offset: 244, short: 'THM', label: 'CPU temperature', kind: 'thermal'},
    {key: 'thm_gfx', offset: 248, short: 'THM', label: 'GPU temperature', kind: 'thermal'},
    {key: 'thm_soc', offset: 252, short: 'THM', label: 'SoC temperature', kind: 'thermal'},
];

/**
 * Finds the logical CPUs of each group of cores.
 *
 * A logical CPU belongs to the group whose frequency when nothing holds it back is the closest to the CPU's maximum
 * frequency in cpufreq, which is 5157895 kHz for the threads of the classic cores of this processor and 3289474 kHz
 * for those of the dense cores.
 *
 * @returns {Set<number>[]} the numbers of the logical CPUs of each group, in the order of CORE_GROUPS, without the CPUs
 *   for which cpufreq reports no maximum frequency
 */
export function findGroupCpus() {
    const groups = CORE_GROUPS.map(() => new Set());
    for (const name of listChildren('/sys/devices/system/cpu')) {
        const match = /^cpu(\d+)$/.exec(name);
        if (!match)
            continue;
        const maxFrequency = Number.parseInt(readText(`/sys/devices/system/cpu/${name}/cpufreq/cpuinfo_max_freq`),
            10) / 1000;
        if (Number.isNaN(maxFrequency))
            continue;
        let closest = 0;
        CORE_GROUPS.forEach((group, index) => {
            if (Math.abs(group.maxFrequency - maxFrequency) <
                Math.abs(CORE_GROUPS[closest].maxFrequency - maxFrequency))
                closest = index;
        });
        groups[closest].add(Number(match[1]));
    }
    return groups;
}

/**
 * Decodes a metrics table.
 *
 * The power of the whole system is the power the firmware reads from the platform's PSYS sensor, the power the
 * laptop's components draw from the AC adapter or the battery, without the power which charges the battery. On
 * battery it was measured within about 2 W of the discharge rate the battery reports at up to 25 W, and about 15% under
 * it at 55 W to 65 W. It is null on a platform which reports none, and for a reading of exactly 65535 mW, which is the
 * table's mark of a field which carries nothing.
 *
 * @param {Uint8Array} bytes - the contents of a gpu_metrics file
 * @returns {object|null} the temperatures in degrees Celsius, the power of the whole system and of the APU and its
 *   parts in watts, the busy percentages of the GPU and the NPU, the clocks of the GPU, the NPU and the memory and of
 *   each group of cores in MHz, and the residency counter of every reason keyed by its name, or null when the contents
 *   are not a table in the layout this decodes
 */
export function decodeMetrics(bytes) {
    if (bytes.length !== STRUCTURE_SIZE)
        return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // structure_size is the size of the table the kernel filled in, so together with the revision it tells the
    // layout apart from the ones other generations publish through the same file.
    if (view.getUint8(OFFSET_FORMAT_REVISION) !== FORMAT_REVISION ||
        view.getUint16(OFFSET_STRUCTURE_SIZE, true) !== STRUCTURE_SIZE)
        return null;

    // The core temperature limit acts on the hottest core, so that is the one worth reporting next to its counter.
    // Only the entries which belong to a core are considered, because the unused ones carry a value as well and
    // it has nothing to do with any core.
    let temperatureCore = 0;
    for (const group of CORE_GROUPS) {
        for (const slot of group.slots) {
            const value = view.getUint16(OFFSET_TEMPERATURE_CORE + 2 * slot, true);
            if (value !== UNSET_UINT16)
                temperatureCore = Math.max(temperatureCore, value);
        }
    }

    // A group runs at one clock per core, and the limit acts on whichever of them is working hardest, so the
    // busiest core of each group is the one whose clock says how much of its speed the group is being allowed.
    const coreGroups = CORE_GROUPS.map(group => {
        let busiest = group.slots[0];
        let busiestPower = 0;
        for (const slot of group.slots) {
            const power = view.getUint16(OFFSET_AVERAGE_CORE_POWER + 2 * slot, true) / 1000;
            if (power > busiestPower) {
                busiestPower = power;
                busiest = slot;
            }
        }
        return {
            name: group.name,
            maxFrequency: group.maxFrequency,
            frequency: view.getUint16(OFFSET_CURRENT_CORECLK + 2 * busiest, true),
        };
    });

    const residency = {};
    for (const reason of REASONS)
        residency[reason.key] = view.getUint32(reason.offset, true);

    // The NPU as a whole is busy for the share of the time its columns are busy on average.
    let npuActivity = 0;
    for (let column = 0; column < NPU_COLUMNS; column++)
        npuActivity += view.getUint16(OFFSET_AVERAGE_IPU_ACTIVITY + 2 * column, true);
    npuActivity /= NPU_COLUMNS;

    // The power of the whole system is in a 16 bit field, which wraps at 65536 mW, and the laptop does draw more than
    // that, for example 68 W with the APU at its fast power limit while the display, the memory and the fan draw 23 W.
    // The laptop's power includes the APU's, so a reading below the APU's has wrapped, and the laptop never draws twice
    // as much. A reading of 0 is a platform without a PSYS sensor.
    const apuPower = view.getUint32(OFFSET_AVERAGE_APU_POWER, true);
    let systemPower = view.getUint16(OFFSET_AVERAGE_SYS_POWER, true);
    if (systemPower === 0 || systemPower === UNSET_UINT16)
        systemPower = null;
    else if (systemPower < apuPower)
        systemPower += UNSET_UINT16 + 1;

    // Temperatures are in hundredths of a degree Celsius, power is in milliwatts and clocks are in MHz.
    return {
        temperatureCore: temperatureCore / 100,
        temperatureGfx: view.getUint16(OFFSET_TEMPERATURE_GFX, true) / 100,
        temperatureSoc: view.getUint16(OFFSET_TEMPERATURE_SOC, true) / 100,
        temperatureSkin: view.getUint16(OFFSET_TEMPERATURE_SKIN, true) / 100,
        systemPower: systemPower === null ? null : systemPower / 1000,
        apuPower: apuPower / 1000,
        corePower: view.getUint32(OFFSET_AVERAGE_ALL_CORE_POWER, true) / 1000,
        graphicsPower: view.getUint32(OFFSET_AVERAGE_GFX_POWER, true) / 1000,
        npuPower: view.getUint16(OFFSET_AVERAGE_IPU_POWER, true) / 1000,
        graphicsActivity: view.getUint16(OFFSET_AVERAGE_GFX_ACTIVITY, true),
        npuActivity,
        graphicsFrequency: view.getUint16(OFFSET_AVERAGE_GFXCLK_FREQUENCY, true),
        npuFrequency: view.getUint16(OFFSET_AVERAGE_IPUCLK_FREQUENCY, true),
        memoryFrequency: view.getUint16(OFFSET_AVERAGE_UCLK_FREQUENCY, true),
        dramReads: view.getUint16(OFFSET_AVERAGE_DRAM_READS, true),
        dramWrites: view.getUint16(OFFSET_AVERAGE_DRAM_WRITES, true),
        coreGroups,
        residency,
    };
}

/**
 * Finds the bandwidths of the DRAM's reads and writes together which a reading of the table can stand for.
 *
 * The table holds the read and the write bandwidth in 16 bit fields of MB/s, which wrap at 65536 MB/s, and the reads do
 * go above that, to about 83 GB/s from the GPU. Nothing in the table tells a wrapped reading from a low one, so the
 * sum of the two fields stands for itself and for every wrap more which still fits under the bandwidth of the memory.
 *
 * @param {object} metrics - a reading, as decodeMetrics returned it
 * @param {number|null} maxBandwidth - the bandwidth in MB/s of the memory at the top of its clock, as findClockLimits
 *   returned it, or null when it is unknown, in which case the sum stands for itself and for one wrap more
 * @returns {number[]} the bandwidths in MB/s, lowest first: one when the reading is unambiguous, more otherwise
 */
export function dramBandwidths(metrics, maxBandwidth) {
    const bandwidth = metrics.dramReads + metrics.dramWrites;
    if (maxBandwidth === null)
        return [bandwidth, bandwidth + DRAM_BANDWIDTH_WRAP];
    const bandwidths = [bandwidth];
    for (let more = bandwidth + DRAM_BANDWIDTH_WRAP; more <= maxBandwidth; more += DRAM_BANDWIDTH_WRAP)
        bandwidths.push(more);
    return bandwidths;
}

/**
 * Reads a properties file of amdkfd's topology, one "name value" pair per line.
 *
 * @param {string} path - the file
 * @returns {Map<string, number>} the values by their names, empty when the file cannot be read
 */
function readKfdProperties(path) {
    const properties = new Map();
    for (const line of (readText(path) ?? '').split('\n')) {
        const [name, value] = line.split(' ');
        if (name && value !== undefined)
            properties.set(name, Number(value));
    }
    return properties;
}

/**
 * Finds the bandwidth of the memory the GPU of a metrics table reads from: the transfer rate of the system's memory
 * times the width of the GPU's memory bus.
 *
 * Both come from amdkfd's topology. The memory banks of a CPU node carry the speed which the memory modules report in
 * SMBIOS, in MT/s, as mem_clk_max, and the memory bank of a GPU node carries the width of the bus amdgpu reads the
 * memory over, in bits, as width. This holds for any memory type, unlike the GPU's memory clock, whose ratio to the
 * transfer rate differs between DDR5 and LPDDR5X. SMBIOS gives the speed the modules are rated for, so with modules
 * which run slower than that, the bandwidth comes out higher than the memory reaches.
 *
 * @param {Gio.File} file - the metrics table, as findMetricsFile returned it
 * @returns {number|null} the bandwidth in MB/s, or null when amdkfd does not report it
 */
function findMemoryBandwidth(file) {
    // The GPU node is the one which renders through the card's render node, which tells it apart from the nodes of
    // other GPUs in the same system.
    const renderNode = listChildren(`${file.get_parent().get_path()}/drm`).find(name => /^renderD\d+$/.test(name));
    if (!renderNode)
        return null;
    const renderMinor = Number(renderNode.slice('renderD'.length));
    let width = null;
    let rate = null;
    for (const node of listChildren(KFD_NODES_PATH)) {
        const properties = readKfdProperties(`${KFD_NODES_PATH}/${node}/properties`);
        const isGpu = properties.get('drm_render_minor') === renderMinor && properties.get('simd_count') > 0;
        const isCpu = properties.get('cpu_cores_count') > 0;
        for (const bank of listChildren(`${KFD_NODES_PATH}/${node}/mem_banks`)) {
            const bankProperties = readKfdProperties(`${KFD_NODES_PATH}/${node}/mem_banks/${bank}/properties`);
            if (isGpu && bankProperties.get('width') > 0)
                width = bankProperties.get('width');
            if (isCpu && rate === null && bankProperties.get('mem_clk_max') > 0)
                rate = bankProperties.get('mem_clk_max');
        }
    }
    return width === null || rate === null ? null : rate * width / 8;
}

/**
 * Finds the frequencies the GPU, the NPU and the memory reach when nothing holds them back, and the bandwidth of the
 * memory, as findMemoryBandwidth finds it.
 *
 * @param {Gio.File} file - the metrics table, as findMetricsFile returned it
 * @returns {{graphics: number|null, npu: number, memory: number|null, memoryBandwidth: number|null}} the frequencies
 *   in MHz and the bandwidth in MB/s, with null for one which the device does not report
 */
export function findClockLimits(file) {
    // amdgpu lists the clock levels of the device's DPM next to its metrics table, one per line as "1: 2900Mhz", and
    // marks the current level with a star.
    const topLevel = name => {
        try {
            const [, contents] = file.get_parent().get_child(name).load_contents(null);
            const levels = [...new TextDecoder().decode(contents).matchAll(/^\d+: (\d+)Mhz/gm)].map(m => Number(m[1]));
            return levels.length ? Math.max(...levels) : null;
        } catch {
            return null;
        }
    };
    return {
        graphics: topLevel('pp_dpm_sclk'),
        npu: NPU_MAX_FREQUENCY,
        memory: topLevel('pp_dpm_mclk'),
        memoryBandwidth: findMemoryBandwidth(file),
    };
}

/**
 * Finds the file through which a device publishes a metrics table this can decode.
 *
 * @returns {Gio.File|null} the file, or null when no device on this system publishes such a table
 */
export function findMetricsFile() {
    // The index of a card depends on the order the devices came up, so it is not stable across boots and every
    // card has to be tried. A card of a generation that publishes a different layout fails to decode and is skipped.
    for (const card of listCards()) {
        const file = Gio.File.new_for_path(`/sys/class/drm/${card}/device/gpu_metrics`);
        try {
            const [, contents] = file.load_contents(null);
            if (decodeMetrics(contents))
                return file;
        } catch {
            // A card without the file at all, which is the usual case for anything but the render device.
        }
    }
    return null;
}

/**
 * Computes how much of the time between two readings the processor spent held back by each reason.
 *
 * @param {object} previous - the earlier reading, as decodeMetrics returned it
 * @param {object} current - the later reading, as decodeMetrics returned it
 * @param {number} elapsed - the milliseconds between the two readings, which has to be above zero
 * @returns {object} the percentage of that time attributed to each reason, keyed by its name
 */
export function throttleShares(previous, current, elapsed) {
    const shares = {};
    for (const reason of REASONS) {
        const grown = (current.residency[reason.key] - previous.residency[reason.key] + COUNTER_MODULUS) %
            COUNTER_MODULUS;
        // Rounding inside the SMU can attribute slightly more than the whole interval to a reason.
        shares[reason.key] = Math.min(100, 100 * grown / elapsed);
    }
    return shares;
}

/**
 * Lists the names of the DRM cards on this system.
 *
 * @returns {string[]} the card names, or an empty array when they cannot be listed
 */
function listCards() {
    const cards = [];
    try {
        const directory = Gio.File.new_for_path('/sys/class/drm');
        const children = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let child;
        while ((child = children.next_file(null)) !== null) {
            // The connectors and the render nodes sit in the same directory and carry the card name as a prefix.
            if (/^card\d+$/.test(child.get_name()))
                cards.push(child.get_name());
        }
        children.close(null);
    } catch {
        // A system without the DRM subsystem present, where there is nothing to find.
    }
    return cards;
}

/**
 * Picks the reason to name as the one holding the processor back.
 *
 * @param {object} shares - the percentages throttleShares returned
 * @param {number} threshold - the percentage a reason has to reach before it counts as holding anything back
 * @returns {object|null} the entry of REASONS with the largest share, or null when none of them reaches the
 *   threshold, which is to say that nothing is holding the processor back
 */
export function dominantReason(shares, threshold) {
    // The largest share is the limit that was binding for most of the interval. REASONS is in the order the kernel
    // declares the counters, and an exact tie goes to the first of them.
    let dominant = null;
    for (const reason of REASONS) {
        if (shares[reason.key] >= threshold && (!dominant || shares[reason.key] > shares[dominant.key]))
            dominant = reason;
    }
    return dominant;
}

/**
 * Tells from the APU's power over time whether the power limits of the embedded controller no longer reach the APU.
 *
 * The EC sends its power limits to the APU over AMD's SB-RMI mailbox. When the mailbox stops answering, the APU keeps
 * the limits it had, and on this laptop it then drew its slow power limit under a steady load for as long as the load
 * lasted, instead of falling to the EC's sustained limit after the first minutes. The check is raised once the APU's
 * power, averaged over OVER_LIMIT_AVERAGE_S, has stayed above every sustained limit the EC sets for OVER_LIMIT_FOR_S,
 * longer than the start of any load stays at the slow power limit. A load which does not hold the APU above that
 * power, such as one under the power saving profile or a bursty one, does not raise it. Once raised, the check stays
 * raised until the sustained limit is seen holding the APU at or below that power again, or until reset is called.
 */
export class SustainedPowerCheck {
    constructor() {
        this.raised = false;
        this._restart();
    }

    /**
     * Adds a sample of the APU's power.
     *
     * @param {number} time - the monotonic time of the sample in seconds
     * @param {number} apuPower - the APU's power in watts
     * @param {number} sustainedShare - the percentage of the time since the sample before in which the sustained power
     *   limit held the APU back
     */
    add(time, apuPower, sustainedShare) {
        const last = this._samples.at(-1);
        if (last && time - last.time > SAMPLE_GAP_S)
            this._restart();
        this._samples.push({time, apuPower, sustainedShare});
        this._firstTime ??= time;
        while (this._samples[0].time <= time - OVER_LIMIT_AVERAGE_S)
            this._samples.shift();
        // Until the samples cover a whole averaging period, a burst at the start of a load could pass for the average.
        if (time - this._firstTime < OVER_LIMIT_AVERAGE_S)
            return;

        const mean = key => this._samples.reduce((sum, sample) => sum + sample[key], 0) / this._samples.length;
        if (mean('apuPower') > OVER_LIMIT_POWER_W) {
            this._overSince ??= time;
            if (time - this._overSince >= OVER_LIMIT_FOR_S)
                this.raised = true;
        } else {
            this._overSince = null;
            if (mean('sustainedShare') >= SUSTAINED_LIMIT_HOLDING_PERCENT)
                this.raised = false;
        }
    }

    /**
     * Forgets the samples and lowers the check. A suspend and resume made the EC's limits reach the APU again on this
     * laptop, so the check starts over after one, and is raised again if the APU still draws too much.
     */
    reset() {
        this._restart();
        this.raised = false;
    }

    _restart() {
        this._samples = [];
        this._firstTime = null;
        // The time from which the average power has stayed above OVER_LIMIT_POWER_W, or null while it is not above.
        this._overSince = null;
    }
}
