#!/usr/bin/python3 -I
"""Log the console and the panics of the embedded controller (EC) to the systemd journal, as a service.

The console of the EC keeps only its latest output, 24 KB with the patched firmware of framework-ec, which lasts from a
few minutes during a boot to hours while the laptop idles. Every 10 seconds the console is read through /dev/cros_ec
and every new line is logged under the identifier ec-console, as the EC printed it, with its own time in seconds since
the EC started in brackets. The journal gives all lines read at once the same time, so the EC's time orders the lines
read at boot, which the EC printed while the laptop was off. A line which looks like an error is logged at priority
err, a warning of Zephyr's log at warning, and every other line at info. The daily mail of journal-digest reports the
errors. When the service stops, at shutdown, it reads the console once more, so the journal has the EC's output up to
then, and at the next boot it reads everything the EC printed since, as far as the console still holds it.

The EC keeps a record of its last crash (a panic) until it loses power. When it answers the first read of the record,
it marks the record as read, so at start the service reads the record and logs a record which was not read before as a
new panic, under the identifier ec-panic at priority crit, with its decoding by framework_tool and its bytes. A record
which was already read is logged at info.

The EC keeps one position up to which its console was read, shared by everything which reads it. The kernel's
cros_ec_debugfs module reads the console every 10 seconds as well, into a buffer of 16 KB which drops the newest output
when it is full, and it reads the panic record when it loads, so it has to be kept from loading (install-ec-log.sh
blacklists it). Commands such as "framework_tool --console" move the position as well, and the service then misses the
lines printed between its last read and theirs, so the console is best followed with "journalctl -t ec-console -f".


Usage
-----
  ec-log                    log the console and a new panic, until stopped (root, as ec-log.service)
  ec-log --classify FILE    print the lines of EC console output in FILE which would be logged at err or warning, with
                            their priority, to try out the patterns on saved console output without the EC or journal
"""

import argparse
import errno
import fcntl
import os
import re
import signal
import struct
import subprocess
import sys
import time

DEVICE = '/dev/cros_ec'
# How long to wait for the device at start, which appears once the kernel's cros_ec_chardev driver has loaded.
DEVICE_WAIT_S = 60
POLL_S = 10
# Each reply of the console holds up to about 250 bytes, so this is more than twice the console of 24 KB.
MAX_CHUNKS = 200
# A read of the console stops after this many failed replies in a row, and continues at the next poll.
MAX_FAILURES = 3
# Large enough for any reply. The kernel shortens it to what the EC can send.
REPLY_SIZE = 256

# _IOWR(0xEC, 0, struct cros_ec_command) of include/linux/platform_data/cros_ec_chardev.h, whose header is five u32:
# version, command, outsize, insize and result. The data follows the header.
CROS_EC_DEV_IOCXCMD = 0xC014EC00
HEADER = struct.Struct('<5I')

EC_CMD_CONSOLE_SNAPSHOT = 0x0097
EC_CMD_CONSOLE_READ = 0x0098
EC_CMD_GET_PANIC_INFO = 0x00D3
# The subcommand of EC_CMD_CONSOLE_READ version 1 which reads what was printed between the previous snapshot and the
# latest one.
CONSOLE_READ_RECENT = 1
# The flags of a panic record are its third byte. The EC sets this one when it answers EC_CMD_GET_PANIC_INFO version 0,
# after it has copied the record into the reply.
PANIC_DATA_FLAGS_BYTE = 2
PANIC_DATA_FLAG_OLD_HOSTCMD = 0x04

# The message ID of a new panic, which journal-digest reports in a section of its own.
EC_PANIC = 'd254011119394bf884b09f752a54ff3e'

PRIORITY_CRIT = 2
PRIORITY_ERR = 3
PRIORITY_WARNING = 4
PRIORITY_INFO = 6

# The start of a line the EC printed with CPRINTS(), with its time. Before it can come the marks the EC prints without a
# newline: "+" and then "(++)" for repeats of the previous host command within 50 ms, and "!", which comes before every
# output during the EC's start.
EC_TIME = re.compile(r'^[+()!]*(\[[0-9]+\.[0-9]+ )?')
ERROR_WORDS = re.compile(
    r'\berr\b|error|fail|fault|time ?out|timed out|exception|panic|assert|watchdog|stalled|overflow|unexpected|invalid'
    r'|unable|cannot|\bbad\b',
    re.IGNORECASE)
CONTROL_CHARACTERS = re.compile(r'[\x00-\x08\x0a-\x1f\x7f]')


class EcError(Exception):
    """The EC answered a command with a result other than success."""


def ec_command(device, command, version, params=b''):
    """Sends a host command to the EC and returns the data of its reply.

    Raises OSError when the transfer fails, for example with EBADMSG for a garbled reply, and EcError when the EC
    answers with an error.
    """
    buffer = bytearray(HEADER.pack(version, command, len(params), REPLY_SIZE, 0xFF))
    buffer += params.ljust(REPLY_SIZE, b'\0')
    received = fcntl.ioctl(device, CROS_EC_DEV_IOCXCMD, buffer)
    result = HEADER.unpack_from(buffer)[4]
    if result != 0:
        raise EcError(f'host command 0x{command:04x} failed with result {result}')
    return bytes(buffer[HEADER.size:HEADER.size + received])


def priority(line):
    """Returns the journal priority to log a line of the EC console at."""
    text = EC_TIME.sub('', line)
    if text.startswith('E: ') or ERROR_WORDS.search(text):
        return PRIORITY_ERR
    if text.startswith('W: '):
        return PRIORITY_WARNING
    return PRIORITY_INFO


def clean(line):
    """Returns a line of the EC console without its control characters, and without the carriage return the EC ends
    some lines with."""
    return CONTROL_CHARACTERS.sub('', line).rstrip()


def open_device():
    """Opens the EC's device, waiting up to DEVICE_WAIT_S for it to appear, and returns its file descriptor.

    Exits with an error when it does not appear or cannot be opened.
    """
    deadline = time.monotonic() + DEVICE_WAIT_S
    while True:
        try:
            return os.open(DEVICE, os.O_RDWR | os.O_CLOEXEC)
        except FileNotFoundError:
            if time.monotonic() >= deadline:
                sys.exit(f'ec-log: {DEVICE} did not appear within {DEVICE_WAIT_S} s')
            time.sleep(1)
        except OSError as error:
            sys.exit(f'ec-log: cannot open {DEVICE}: {error}')


def hex_dump(data):
    """Returns bytes as lines of 16 bytes in hexadecimal, each after its offset."""
    return '\n'.join(f'{offset:04x}: {data[offset:offset + 16].hex(" ")}' for offset in range(0, len(data), 16))


def log_panic(device):
    """Reads the EC's panic record, which marks it as read, and logs it: a new one at crit with EC_PANIC as its message
    ID, one which was already read at info. Logs nothing when the EC has no record."""
    from systemd import journal

    try:
        record = ec_command(device, EC_CMD_GET_PANIC_INFO, 0)
    except (OSError, EcError) as error:
        journal.send(f'reading the EC panic record failed: {error}', PRIORITY=PRIORITY_WARNING,
                     SYSLOG_IDENTIFIER='ec-log')
        return
    if not record:
        return
    flags = record[PANIC_DATA_FLAGS_BYTE] if len(record) > PANIC_DATA_FLAGS_BYTE else 0
    if flags & PANIC_DATA_FLAG_OLD_HOSTCMD:
        journal.send(f'The EC holds a panic record which was read before, flags 0x{flags:02x}', PRIORITY=PRIORITY_INFO,
                     SYSLOG_IDENTIFIER='ec-panic')
        return

    # framework_tool reads the record again to decode it, without marking it. Its output shows the flags of this
    # second read, which include the one the read above set.
    try:
        decoded = subprocess.run(['framework_tool', '--panicinfo'], capture_output=True, text=True, timeout=60,
                                 check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        decoded = f'framework_tool --panicinfo failed: {error}'
    journal.send(f'The EC crashed: it holds a new panic record, flags 0x{flags:02x}.\n\n{decoded}\n\n'
                 f'The record:\n{hex_dump(record)}',
                 PRIORITY=PRIORITY_CRIT, SYSLOG_IDENTIFIER='ec-panic', MESSAGE_ID=EC_PANIC)


class Console:
    """Reads the EC console and logs its lines."""

    def __init__(self, device):
        self.device = device
        # The output after the last complete line, which the next read continues.
        self.partial = ''

    def read(self):
        """Returns the output the EC printed since the previous read, and the errors of the commands which failed.

        The output of a reply which was lost is missing, because the EC moves its position as it sends the output.
        """
        errors = []
        try:
            ec_command(self.device, EC_CMD_CONSOLE_SNAPSHOT, 0)
        except (OSError, EcError) as error:
            # When only the reply was lost, the EC made the snapshot and the reads below return the output up to it.
            # Otherwise they return the output up to the previous snapshot which is still unread, if any.
            errors.append(error)
        chunks = []
        failures = 0
        for _ in range(MAX_CHUNKS):
            try:
                reply = ec_command(self.device, EC_CMD_CONSOLE_READ, 1, bytes([CONSOLE_READ_RECENT]))
            except (OSError, EcError) as error:
                errors.append(error)
                failures += 1
                if failures >= MAX_FAILURES:
                    break
                continue
            failures = 0
            # Each reply ends with a null byte, and an empty one means that the output up to the snapshot was read.
            chunk = reply.split(b'\0', 1)[0]
            if not chunk:
                break
            chunks.append(chunk)
        return b''.join(chunks).decode(errors='replace'), errors

    def poll(self):
        """Reads the EC console and logs its new complete lines. Logs a warning when a command failed."""
        from systemd import journal

        output, errors = self.read()
        if errors:
            journal.send(f'reading the EC console failed {len(errors)} time(s), some of its lines are missing: '
                         f'{errors[-1]}', PRIORITY=PRIORITY_WARNING, SYSLOG_IDENTIFIER='ec-log')
        *lines, self.partial = (self.partial + output).split('\n')
        for line in lines:
            self.log(line)

    def flush(self):
        """Logs the output after the last complete line."""
        self.log(self.partial)
        self.partial = ''

    def log(self, line):
        """Logs a line of the EC console, unless it is empty."""
        from systemd import journal

        line = clean(line)
        if line:
            journal.send(line, PRIORITY=priority(line), SYSLOG_IDENTIFIER='ec-console')


def run():
    """Logs a new panic, then the console every POLL_S until SIGTERM or SIGINT, after which it reads the console once
    more."""
    # The signals are blocked and only waited for, so that they never interrupt a host command, of which the EC would
    # then have sent output which is lost.
    stop_signals = {signal.SIGTERM, signal.SIGINT}
    signal.pthread_sigmask(signal.SIG_BLOCK, stop_signals)
    device = open_device()
    log_panic(device)
    console = Console(device)
    while True:
        console.poll()
        if signal.sigtimedwait(stop_signals, POLL_S) is not None:
            break
    console.poll()
    console.flush()


def classify(path):
    """Prints the lines of EC console output in a file which would be logged at err or warning, with their priority."""
    try:
        with open(path, errors='replace') as file:
            lines = file.read().split('\n')
    except OSError as error:
        sys.exit(f'ec-log: {error}')
    for line in lines:
        line = clean(line)
        if line and priority(line) <= PRIORITY_WARNING:
            print(f'{priority(line)} {line}')


def main():
    parser = argparse.ArgumentParser(description='Log the console and the panics of the EC to the systemd journal.')
    parser.add_argument('--classify', metavar='FILE', help='print the lines of EC console output in FILE which would '
                                                           'be logged at err or warning, with their priority')
    args = parser.parse_args()
    if args.classify:
        classify(args.classify)
        return
    if os.geteuid() != 0:
        sys.exit(f'ec-log: reading {DEVICE} requires root')
    run()


if __name__ == '__main__':
    main()
