#!/usr/bin/env python3
#
# Owns org.freedesktop.systemd1 on the session bus, answers StartTransientUnit as MODE says, and runs COMMAND meanwhile.
# See README.
#
# Usage: fake_systemd.py MODE COMMAND [ARGUMENT...]
#
# MODE is one of:
#
#   refuse   refuses every request
#   fail     accepts every request, and then sends JobRemoved for its job with result failed
#   slow     accepts every request, and only SLOW_S seconds later moves the process into a cgroup named after the scope,
#            next to the cgroup the process is in, which the user instance has to have delegated to this user, and
#            then sends JobRemoved for its job with result done
#   check    checks the caller of every request on the bus CHECK_S seconds after receiving it, as systemd does before
#            it acts on a request, and refuses the request with ENXIO, as systemd does, when the caller is gone by then,
#            and otherwise moves the process at once, as slow does
#
# COMMAND starts once the name is owned. Exits with the exit status of COMMAND, once COMMAND exited and every request
# received until then is finished, or LINGER_S seconds after COMMAND exited, as gio-launch-desktop asks for the scope
# also after a launching process which exits right after launching is gone.

import pathlib
import sys

from gi.repository import Gio, GLib

# The duration of a slow request, longer than the 5 seconds gio-launch-desktop once waited at most.
SLOW_S = 7
# How long a request waits before its caller is checked, longer than a launching process needs to exit.
CHECK_S = 0.5
LINGER_S = SLOW_S + 5

INTERFACE = Gio.DBusNodeInfo.new_for_xml(
    """
    <node>
      <interface name="org.freedesktop.systemd1.Manager">
        <method name="StartTransientUnit">
          <arg type="s" direction="in"/>
          <arg type="s" direction="in"/>
          <arg type="a(sv)" direction="in"/>
          <arg type="a(sa(sv))" direction="in"/>
          <arg type="o" direction="out"/>
        </method>
        <signal name="JobRemoved">
          <arg type="u"/>
          <arg type="o"/>
          <arg type="s"/>
          <arg type="s"/>
        </signal>
      </interface>
    </node>
    """
).interfaces[0]

mode = sys.argv[1]
loop = GLib.MainLoop()
status = None
jobs = 0
# Requests received, and requests finished, refused or with their job ended.
received = 0
finished = 0


def finish_request():
    global finished
    finished += 1
    maybe_quit()


def maybe_quit():
    if status is not None and finished == received and received > 0:
        loop.quit()


def pid_of(properties, message):
    for name, value in properties:
        if name == "PIDs":
            return value[0]
        if name == "PIDFDs":
            fd = message.get_unix_fd_list().get(value[0])
            for line in pathlib.Path(f"/proc/self/fdinfo/{fd}").read_text().splitlines():
                if line.startswith("Pid:"):
                    return int(line.split()[1])
    raise ValueError("no process in the request")


def job_removed(connection, job_id, job, unit, result):
    connection.emit_signal(None, "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "JobRemoved",
                           GLib.Variant("(uoss)", (job_id, job, unit, result)))
    finish_request()
    return False


def move(connection, job_id, job, unit, pid):
    cgroup = pathlib.Path("/sys/fs/cgroup" + pathlib.Path(f"/proc/{pid}/cgroup").read_text().split("::", 1)[1].strip())
    scope = cgroup.parent / unit
    scope.mkdir(exist_ok=True)
    (scope / "cgroup.procs").write_text(f"{pid}\n")
    return job_removed(connection, job_id, job, unit, "done")


def accept(connection, invocation, unit, pid, delay_s):
    global jobs
    jobs += 1
    job = f"/org/freedesktop/systemd1/job/{jobs}"
    invocation.return_value(GLib.Variant("(o)", (job,)))
    if mode == "fail":
        GLib.idle_add(job_removed, connection, jobs, job, unit, "failed")
    else:
        GLib.timeout_add(int(delay_s * 1000), move, connection, jobs, job, unit, pid)


def check_caller(connection, sender, invocation, unit, pid):
    try:
        connection.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixUser",
                             GLib.Variant("(s)", (sender,)), GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, -1, None)
    except GLib.Error:
        # The reply goes to a caller which is gone, which the bus drops, so nothing learns of the refusal.
        invocation.return_dbus_error("System.Error.ENXIO", "No such device or address")
        finish_request()
        return False
    accept(connection, invocation, unit, pid, 0)
    return False


def method_call(connection, sender, _path, _interface, _method, parameters, invocation):
    global received
    received += 1
    unit, _mode, properties, _aux = parameters.unpack()
    if mode == "refuse":
        invocation.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", f"Refused {unit} for the test")
        finish_request()
        return
    pid = pid_of(properties, invocation.get_message())
    if mode == "check":
        GLib.timeout_add(int(CHECK_S * 1000), check_caller, connection, sender, invocation, unit, pid)
    else:
        accept(connection, invocation, unit, pid, SLOW_S)


def command_exited(_pid, wait_status):
    global status
    try:
        GLib.spawn_check_wait_status(wait_status)
        status = 0
    except GLib.Error:
        status = 1
    maybe_quit()
    GLib.timeout_add_seconds(LINGER_S, lambda: loop.quit())


def name_acquired(connection, _name):
    pid, *_ = GLib.spawn_async(sys.argv[2:], flags=GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD)
    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, command_exited)


def bus_acquired(connection, _name):
    connection.register_object("/org/freedesktop/systemd1", INTERFACE, method_call, None, None)


Gio.bus_own_name(Gio.BusType.SESSION, "org.freedesktop.systemd1", Gio.BusNameOwnerFlags.NONE, bus_acquired, name_acquired,
                 lambda *_: loop.quit())
loop.run()
sys.exit(1 if status is None else status)
