"""Run Text Editor seven times to test that GTK names its windows to the compositor and restores them. See README.

Usage: text_editor_session.py TEXT_EDITOR OUT_DIR SCENARIO

TEXT_EDITOR is the gnome-text-editor binary to run, with the GTK it is to use already on LD_LIBRARY_PATH. The
first run opens two files, each in a window of its own, and quits. The second run starts without files, which
restores the last session. The third run does the same while two more launches arrive before Text Editor loaded
its session. The fourth run starts with --ignore-session, so that Text Editor has to discard the windows GTK
restores. The fifth run opens both files again and closes both windows, after which nothing is restored. The sixth
run opens both files again, types into each, and ends with SIGTERM, and the seventh run restores both windows with
the text typed into them. Text Editor's output, with its Wayland requests and events, goes to
OUT_DIR/runN.log.
SCENARIO says which session manager the private D-Bus session has, which run-text-editor-session.sh sets up:
none, unsupported (RestoreSupported is false) or supported (RestoreSupported is true), and so whether GTK has to
register with it. The exit status is 0 when every check passed.
"""

import os
import re
import signal
import subprocess
import sys
import time

from gi.repository import Gio, GLib

APP_ID = "org.gnome.TextEditor"

# Each of these is matched in the WAYLAND_DEBUG output of Text Editor, where "->" marks a request it sends.
PATTERNS = {
    "get_session": re.compile(r'-> xx_session_manager_v1#\d+\.get_session\(new id xx_session_v1#\d+, (\d+), ("[^"]*"|nil)\)'),
    "created": re.compile(r'xx_session_v1#\d+\.created\("([^"]*)"\)'),
    "restored_session": re.compile(r'xx_session_v1#\d+\.restored\(\)'),
    "add_toplevel": re.compile(r'-> xx_session_v1#\d+\.add_toplevel\(new id xx_toplevel_session_v1#\d+, xdg_toplevel#\d+, "([^"]*)"\)'),
    "restore_toplevel": re.compile(r'-> xx_session_v1#\d+\.restore_toplevel\(new id xx_toplevel_session_v1#\d+, xdg_toplevel#\d+, "([^"]*)"\)'),
    "restored_toplevel": re.compile(r'xx_toplevel_session_v1#\d+\.restored\(xdg_toplevel#\d+\)'),
    "remove": re.compile(r'-> xx_toplevel_session_v1#\d+\.remove\(\)'),
    "error": re.compile(r'wl_display#\d+\.error\(|[Pp]rotocol error'),
}

# The activation token the second run is launched with, in both variables launchers set. The compositor does not
# know it and ignores it, but the WAYLAND_DEBUG output shows the window Text Editor presents it with.
TOKEN = "text-editor-session-test-token"

# Text typed into the documents, in run 6 into the first and the second file, and in run 7 after the restore.
TYPED = ("typed into the first file", "typed into the second file", "typed after the restore")

# Keysyms pressed through mutter's remote desktop API.
ALT, F4, RETURN = 0xffe9, 0xffc1, 0xff0d

failures = []


def check(condition, message):
    print(("ok:   " if condition else "FAIL: ") + message)
    if not condition:
        failures.append(message)


def scan(log_path):
    with open(log_path, errors="replace") as log:
        text = log.read()
    return {name: pattern.findall(text) for name, pattern in PATTERNS.items()}


def wait_for(log_path, name, count, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if len(scan(log_path)[name]) >= count:
            return True
        time.sleep(0.2)
    return False


def wait_until(predicate, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if predicate():
                return True
        except (OSError, GLib.Error):
            pass
        time.sleep(0.2)
    return False


def quit_text_editor(proc):
    # app.quit saves the session of Text Editor and quits, and GTK saves its window state while shutting down.
    subprocess.run(["gdbus", "call", "--session", "--dest", APP_ID, "--object-path", "/org/gnome/TextEditor",
                    "--method", "org.gtk.Actions.Activate", "quit", "[]", "{}"],
                   check=True, stdout=subprocess.DEVNULL)
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        check(False, "Text Editor quit within 30 seconds")


def start(text_editor, args, log_path, token=None):
    log = open(log_path, "w")
    env = dict(os.environ, WAYLAND_DEBUG="1")
    if token:
        env.update(XDG_ACTIVATION_TOKEN=token, DESKTOP_STARTUP_ID=token)
    return subprocess.Popen([text_editor] + args, stdout=log, stderr=subprocess.STDOUT, env=env)


def toplevel_kinds(log_path, surface_events):
    """Returns for each line matched by the pattern surface_events, whose last group is a wl_surface ID, whether the
    window of that surface is one the compositor restored ("restored"), another one ("new"), or none (None)."""
    xdg_surfaces, toplevels, restored, found = {}, {}, set(), []
    with open(log_path, errors="replace") as log:
        for line in log:
            if match := re.search(r"-> xdg_wm_base#\d+\.get_xdg_surface\(new id xdg_surface#(\d+), wl_surface#(\d+)\)", line):
                xdg_surfaces[match[1]] = match[2]
            elif match := re.search(r"-> xdg_surface#(\d+)\.get_toplevel\(new id xdg_toplevel#(\d+)\)", line):
                toplevels[xdg_surfaces.get(match[1])] = match[2]
            elif match := re.search(r"xx_toplevel_session_v1#\d+\.restored\(xdg_toplevel#(\d+)\)", line):
                restored.add(match[1])
            elif match := surface_events.search(line):
                found.append(toplevels.get(match.groups()[-1]))
    return [None if t is None else "restored" if t in restored else "new" for t in found]


def activated(log_path, token=None):
    """The kind of window, see toplevel_kinds, of each activation request with token, or with any token."""
    token_pattern = re.escape(token) if token else r'[^"]*'
    return toplevel_kinds(log_path, re.compile(r'-> xdg_activation_v1#\d+\.activate\("%s", wl_surface#(\d+)\)' % token_pattern))


def focused(log_path):
    """The kind of window, see toplevel_kinds, which received the keyboard focus last, or None."""
    kinds = toplevel_kinds(log_path, re.compile(r"wl_keyboard#\d+\.enter\(\d+, wl_surface#(\d+),"))
    return kinds[-1] if kinds else None


def last_window_focused(log_path):
    """Whether the window which received the keyboard focus last is the window created last."""
    xdg_surfaces, toplevels, created, last = {}, {}, [], None
    with open(log_path, errors="replace") as log:
        for line in log:
            if match := re.search(r"-> xdg_wm_base#\d+\.get_xdg_surface\(new id xdg_surface#(\d+), wl_surface#(\d+)\)", line):
                xdg_surfaces[match[1]] = match[2]
            elif match := re.search(r"-> xdg_surface#(\d+)\.get_toplevel\(new id xdg_toplevel#(\d+)\)", line):
                toplevels[xdg_surfaces.get(match[1])] = match[2]
                created.append(match[2])
            elif match := re.search(r"wl_keyboard#\d+\.enter\(\d+, wl_surface#(\d+),", line):
                last = toplevels.get(match[1])
    return last is not None and created and last == created[-1]


def press(keyboard, keysym, modifier=None):
    def key(sym, pressed):
        keyboard.call_sync("NotifyKeyboardKeysym", GLib.Variant("(ub)", (sym, pressed)), Gio.DBusCallFlags.NONE, -1, None)
    if modifier:
        key(modifier, True)
    key(keysym, True)
    key(keysym, False)
    if modifier:
        key(modifier, False)


def type_text(keyboard, text):
    """Types ASCII text, whose keysyms are the codes of its characters, followed by Return."""
    for char in text:
        press(keyboard, ord(char))
    press(keyboard, RETURN)


def add_keyboard():
    """Adds a keyboard to mutter's seat through its remote desktop API, by pressing Shift, so that mutter gives the
    keyboard focus to windows. Returns the remote desktop session, which keeps the keyboard until it is stopped."""
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    desktop = Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.NONE, None, "org.gnome.Mutter.RemoteDesktop",
                                     "/org/gnome/Mutter/RemoteDesktop", "org.gnome.Mutter.RemoteDesktop", None)
    path = desktop.call_sync("CreateSession", None, Gio.DBusCallFlags.NONE, -1, None).unpack()[0]
    session = Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.NONE, None, "org.gnome.Mutter.RemoteDesktop", path,
                                     "org.gnome.Mutter.RemoteDesktop.Session", None)
    session.call_sync("Start", None, Gio.DBusCallFlags.NONE, -1, None)
    for pressed in (True, False):
        session.call_sync("NotifyKeyboardKeysym", GLib.Variant("(ub)", (0xffe1, pressed)), Gio.DBusCallFlags.NONE, -1,
                          None)
    return session


def open_count(pid, target):
    """The number of file descriptors process pid has open on the file whose os.stat() result is target."""
    count = 0
    fd_dir = "/proc/%d/fd" % pid
    for fd in os.listdir(fd_dir):
        try:
            st = os.stat(os.path.join(fd_dir, fd))
        except OSError:
            continue
        if (st.st_dev, st.st_ino) == (target.st_dev, target.st_ino):
            count += 1
    return count


def load_variant(path, type_string):
    with open(path, "rb") as f:
        data = f.read()
    return GLib.Variant.new_from_bytes(GLib.VariantType(type_string), GLib.Bytes.new(data), False).unpack()


def session_path():
    return os.path.join(GLib.get_user_data_dir(), APP_ID, "session.gvariant")


def editor_windows():
    """The windows of Text Editor's session state which have pages, as (window ID, URIs of the pages)."""
    state = load_variant(session_path(), "a{sv}")
    return [(w.get("window-id"), sorted(p.get("uri", "") for p in w.get("pages", [])))
            for w in state.get("windows", []) if w.get("pages")]


def draft_texts():
    """The drafts of the pages of Text Editor's session state, as {URI of the page: text of its draft}."""
    state = load_variant(session_path(), "a{sv}")
    drafts_dir = os.path.join(GLib.get_user_data_dir(), APP_ID, "drafts")
    texts = {}
    for window in state.get("windows", []):
        for page in window.get("pages", []):
            path = os.path.join(drafts_dir, page.get("draft-id", ""))
            if page.get("draft-id") and os.path.exists(path):
                with open(path, errors="replace") as f:
                    texts[page.get("uri", "")] = f.read()
    return texts


def gtk_windows(path):
    """The windows of GTK's state file, as (window ID of Text Editor, Wayland toplevel name)."""
    global_gtk, _, windows = load_variant(path, "(a{sv}a{sv}a(a{sv}a{sv}))")
    return global_gtk.get("wayland-session"), [(app.get("window-id"), gtk.get("session-id")) for gtk, app in windows]


def summary(run, found):
    print("run %d: get_session %s, created %s, restored session %d" % (
        run, found["get_session"], found["created"], len(found["restored_session"])))
    print("run %d: restore_toplevel %s, add_toplevel %s, restored %d, removed %d" % (
        run, found["restore_toplevel"], found["add_toplevel"], len(found["restored_toplevel"]), len(found["remove"])))


def main():
    text_editor, out, scenario = sys.argv[1:4]
    files = []
    for name in ("first.txt", "second.txt"):
        path = os.path.join(out, name)
        with open(path, "w") as f:
            f.write("The %s file.\n" % name.split(".")[0])
        files.append(path)
    uris = sorted(GLib.filename_to_uri(path, None) for path in files)

    # Run 1: the first file opens in the first window, the second one in a window of its own.
    log1 = os.path.join(out, "run1.log")
    proc1 = proc = start(text_editor, [files[0]], log1)
    check(wait_for(log1, "restore_toplevel", 1), "run 1: the first window was named to the compositor")
    with open(os.path.join(out, "run1-new-window.log"), "w") as log:
        subprocess.run([text_editor, "--new-window", files[1]], stdout=log, stderr=subprocess.STDOUT, check=True)
    check(wait_for(log1, "restore_toplevel", 2), "run 1: the second window was named to the compositor")
    time.sleep(2)
    quit_text_editor(proc)
    run1 = scan(log1)
    summary(1, run1)
    check(not run1["error"], "run 1: no protocol error")
    check(len(run1["get_session"]) == 1 and run1["get_session"][0][1] == "nil", "run 1: a new session was requested")
    check(len(run1["created"]) == 1, "run 1: the compositor created the session")
    check(not run1["restored_toplevel"], "run 1: no window was restored")

    state_name = "%s@%s.state" % (APP_ID, "test-instance" if scenario == "supported" else "fallback")
    state_path = os.path.join(GLib.get_user_state_dir(), state_name)
    check(os.path.exists(state_path), "GTK saved its state as %s" % state_name)
    if not os.path.exists(state_path):
        return 1
    session1, gtk1 = gtk_windows(state_path)
    editor1 = editor_windows()
    print("GTK state: session %s, windows %s" % (session1, gtk1))
    print("Text Editor session: windows %s" % editor1)
    check(session1 == run1["created"][0], "GTK saved the session the compositor created")
    check(sorted(name for _, name in gtk1) == sorted(run1["restore_toplevel"]), "GTK saved the names of both windows")
    check(sorted(i for i, _ in gtk1) == sorted(i for i, _ in editor1) and None not in [i for i, _ in gtk1],
          "GTK and Text Editor saved the same two window IDs")
    check(sorted(u for _, pages in editor1 for u in pages) == uris, "Text Editor saved both files")

    # Run 2: launched with an activation token, restores the session, and with it both windows under the names of
    # run 1, and opens a new window with a draft beside them, which receives the token and the keyboard focus. No
    # restored window is activated. Without a keyboard, mutter gives no window the focus.
    keyboard = add_keyboard()
    log2 = os.path.join(out, "run2.log")
    proc2 = proc = start(text_editor, [], log2, TOKEN)
    check(wait_for(log2, "restored_toplevel", 2), "run 2: the compositor restored both windows")
    check(wait_for(log2, "restore_toplevel", 3), "run 2: a new window was named to the compositor beside them")
    time.sleep(2)
    check(focused(log2) == "new", "run 2: the new window has the keyboard focus (%s)" % focused(log2))
    keyboard.call_sync("Stop", None, Gio.DBusCallFlags.NONE, -1, None)
    quit_text_editor(proc)
    run2 = scan(log2)
    summary(2, run2)
    check(not run2["error"], "run 2: no protocol error")
    check(len(run2["get_session"]) == 1 and run2["get_session"][0][1] == '"%s"' % session1,
          "run 2: the session of run 1 was requested")
    check(len(run2["restored_session"]) == 1, "run 2: the compositor restored the session")
    check(set(run1["restore_toplevel"]) <= set(run2["restore_toplevel"]) and len(run2["restore_toplevel"]) == 3,
          "run 2: the restored windows used their names of run 1, and the new window a name of its own")
    check(activated(log2, TOKEN) == ["new"], "run 2: the activation token was presented with the new window only (%s)"
          % activated(log2, TOKEN))
    check("restored" not in activated(log2), "run 2: no restored window was activated (%s)" % activated(log2))

    session2, gtk2 = gtk_windows(state_path)
    editor2 = editor_windows()
    print("GTK state: session %s, windows %s" % (session2, gtk2))
    print("Text Editor session: windows %s" % editor2)
    check(set(gtk1) <= set(gtk2) and len(gtk2) == 3, "run 2: GTK saved the same windows again and the new one")
    check(sorted(editor2) == sorted(editor1), "run 2: each window has the file it had in run 1, the new one none")

    # Run 3: Text Editor reads its session from a pipe, which receives the session saved by run 2 only after two more
    # launches from the command line arrived, one without files and one with a third file. Opened for reading and
    # writing here, the pipe does not block Text Editor opening it, so each load of the session keeps it open while
    # reading. Text Editor has to load its session once, restore both windows of run 1, and then open a window for
    # each launch: two with a draft and one with the third file.
    third = os.path.join(out, "third.txt")
    with open(third, "w") as f:
        f.write("The third file.\n")
    with open(session_path(), "rb") as f:
        session_bytes = f.read()
    os.unlink(session_path())
    os.mkfifo(session_path())
    pipe = os.open(session_path(), os.O_RDWR)
    fifo = os.fstat(pipe)
    keyboard = add_keyboard()
    log3 = os.path.join(out, "run3.log")
    proc3 = proc = start(text_editor, [], log3)
    deadline = time.time() + 30
    while open_count(proc.pid, fifo) == 0 and time.time() < deadline:
        time.sleep(0.1)
    check(open_count(proc.pid, fifo) == 1, "run 3: Text Editor started loading its session")
    # A remote instance exits once Text Editor handled its command line.
    with open(os.path.join(out, "run3-launches.log"), "w") as log:
        subprocess.run([text_editor], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)
        subprocess.run([text_editor, third], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=30)
    time.sleep(1)
    loads = open_count(proc.pid, fifo)
    check(loads == 1, "run 3: the launches did not load the session again (loading it %d times)" % loads)
    check(not scan(log3)["restore_toplevel"], "run 3: no window was shown before the session was loaded")
    # Saving the session over the pipe would block, so it is removed first. Text Editor reads it until the last
    # writer closes it.
    os.unlink(session_path())
    os.write(pipe, session_bytes)
    os.close(pipe)
    check(wait_for(log3, "restored_toplevel", 2), "run 3: the compositor restored both windows")
    check(wait_for(log3, "restore_toplevel", 5), "run 3: three new windows were named to the compositor beside them")
    time.sleep(2)
    check(focused(log3) == "new", "run 3: a new window has the keyboard focus (%s)" % focused(log3))
    keyboard.call_sync("Stop", None, Gio.DBusCallFlags.NONE, -1, None)
    quit_text_editor(proc)
    run3 = scan(log3)
    summary(3, run3)
    check(not run3["error"], "run 3: no protocol error")
    check(len(run3["restored_toplevel"]) == 2, "run 3: no other window was restored")
    check(set(run1["restore_toplevel"]) <= set(run3["restore_toplevel"]) and len(run3["restore_toplevel"]) == 5,
          "run 3: the restored windows used their names of run 1, and the three new windows names of their own")
    check("restored" not in activated(log3), "run 3: no restored window was activated (%s)" % activated(log3))

    check(os.path.exists(session_path()), "run 3: Text Editor saved its session")
    if not os.path.exists(session_path()):
        return 1
    _, gtk3 = gtk_windows(state_path)
    editor3 = editor_windows()
    print("GTK state: windows %s" % gtk3)
    print("Text Editor session: windows %s" % editor3)
    check(set(gtk1) <= set(gtk3) and len(gtk3) == 5, "run 3: GTK saved the restored windows and the three new ones")
    window_ids = [i for i, _ in editor3]
    check(len(set(window_ids)) == len(window_ids) and all(w in editor3 for w in editor1),
          "run 3: each window of run 1 was saved once, with its file")
    check(sorted(u for _, pages in editor3 for u in pages) == sorted(uris + [GLib.filename_to_uri(third, None)]),
          "run 3: Text Editor saved each file once")

    # Run 4: --ignore-session makes the session restore open one new window instead of restoring the windows, so the
    # five windows created for GTK's restored window state are destroyed without ever being shown.
    log4 = os.path.join(out, "run4.log")
    proc = start(text_editor, ["--ignore-session"], log4)
    check(wait_for(log4, "restore_toplevel", 1), "run 4: a window was named to the compositor")
    time.sleep(2)
    check(proc.poll() is None, "run 4: Text Editor still runs after discarding the restored windows")
    quit_text_editor(proc)
    run4 = scan(log4)
    summary(4, run4)
    check(not run4["error"], "run 4: no protocol error")
    check(len(run4["restore_toplevel"]) == 1 and run4["restore_toplevel"][0] not in run3["restore_toplevel"],
          "run 4: only the new window was named, under a new name")
    check(not run4["restored_toplevel"], "run 4: no window was restored")
    _, gtk4 = gtk_windows(state_path)
    print("GTK state: windows %s" % gtk4)
    check(len(gtk4) == 1 and gtk4[0][0] not in [i for i, _ in gtk3] and gtk4[0][1] == run4["restore_toplevel"][0],
          "run 4: GTK saved only the new window")
    proc4 = proc
    for run, p in ((1, proc1), (2, proc2), (3, proc3), (4, proc4)):
        check(p.returncode == 0, "run %d: Text Editor exited with 0, not %s" % (run, p.returncode))

    # Run 5: both files open again, each in a window of its own, and the windows are closed one after the other with
    # Alt+F4. Each window leaves the session, the last one too, so Text Editor quits with no window to restore.
    keyboard = add_keyboard()
    log5 = os.path.join(out, "run5.log")
    proc5 = start(text_editor, [files[0]], log5)
    check(wait_for(log5, "restore_toplevel", 1), "run 5: the first window was named to the compositor")
    with open(os.path.join(out, "run5-new-window.log"), "w") as log:
        subprocess.run([text_editor, "--new-window", files[1]], stdout=log, stderr=subprocess.STDOUT, check=True)
    check(wait_for(log5, "restore_toplevel", 2), "run 5: the second window was named to the compositor")
    check(wait_until(lambda: sorted(u for _, pages in editor_windows() for u in pages) == uris),
          "run 5: the session saved both windows with their files")
    check(wait_until(lambda: last_window_focused(log5)), "run 5: the second window has the keyboard focus")
    press(keyboard, F4, ALT)
    check(wait_until(lambda: len(editor_windows()) == 1), "run 5: the session saved closing the second window")
    # Mutter gives the keyboard focus to the first window once the second is gone.
    time.sleep(1)
    press(keyboard, F4, ALT)
    try:
        proc5.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc5.kill()
        proc5.wait()
    check(proc5.returncode == 0, "run 5: Text Editor quit once its last window was closed (status %s)" % proc5.returncode)
    keyboard.call_sync("Stop", None, Gio.DBusCallFlags.NONE, -1, None)
    run5 = scan(log5)
    summary(5, run5)
    check(not run5["error"], "run 5: no protocol error")
    check(not editor_windows(), "run 5: the session saved no window to restore")

    # Run 6: each of the two files has text typed into it, which Text Editor keeps as a draft, and once it autosaved
    # its session with both drafts and GTK saved its window state, Text Editor is ended with SIGTERM, which it does
    # not handle, so it closes no window and saves nothing more.
    keyboard = add_keyboard()
    log6 = os.path.join(out, "run6.log")
    proc6 = start(text_editor, [files[0]], log6)
    check(wait_for(log6, "restore_toplevel", 1), "run 6: the first window was named to the compositor")
    check(not scan(log6)["restored_toplevel"], "run 6: no window closed in run 5 was restored")
    check(wait_until(lambda: last_window_focused(log6)), "run 6: the first window has the keyboard focus")
    type_text(keyboard, TYPED[0])
    with open(os.path.join(out, "run6-new-window.log"), "w") as log:
        subprocess.run([text_editor, "--new-window", files[1]], stdout=log, stderr=subprocess.STDOUT, check=True)
    check(wait_for(log6, "restore_toplevel", 2), "run 6: the second window was named to the compositor")
    check(wait_until(lambda: last_window_focused(log6)), "run 6: the second window has the keyboard focus")
    type_text(keyboard, TYPED[1])
    file_uris = [GLib.filename_to_uri(path, None) for path in files]
    check(wait_until(lambda: all(typed in draft_texts().get(uri, "") for typed, uri in zip(TYPED, file_uris))),
          "run 6: the session saved a draft of each file with the text typed into it")
    run6_names = scan(log6)["restore_toplevel"]
    check(wait_until(lambda: sorted(n for _, n in gtk_windows(state_path)[1]) == sorted(run6_names), timeout=60),
          "run 6: GTK saved the names of both windows")
    editor6 = editor_windows()
    proc6.send_signal(signal.SIGTERM)
    try:
        proc6.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc6.kill()
        proc6.wait()
    check(proc6.returncode == -signal.SIGTERM, "run 6: SIGTERM ended Text Editor (status %s)" % proc6.returncode)
    keyboard.call_sync("Stop", None, Gio.DBusCallFlags.NONE, -1, None)
    run6 = scan(log6)
    summary(6, run6)
    print("Text Editor session: windows %s" % editor6)
    check(not run6["error"], "run 6: no protocol error")
    check(sorted(u for _, pages in editor6 for u in pages) == uris, "run 6: the session has both files")
    check(editor_windows() == editor6, "run 6: the session kept both windows after SIGTERM")

    # Run 7: restores both windows under their names of run 6, and opens a new window beside them. Closing the new
    # window, which has only an empty draft, gives the keyboard focus to a restored window, and text typed into it
    # is autosaved to its draft. The draft holds the text typed in run 6 only if the restored document has it.
    keyboard = add_keyboard()
    log7 = os.path.join(out, "run7.log")
    proc7 = start(text_editor, [], log7)
    check(wait_for(log7, "restored_toplevel", 2), "run 7: the compositor restored both windows")
    check(wait_for(log7, "restore_toplevel", 3), "run 7: a new window was named to the compositor beside them")
    run7 = scan(log7)
    check(set(run6_names) <= set(run7["restore_toplevel"]), "run 7: the restored windows used their names of run 6")
    check(wait_until(lambda: focused(log7) == "new"), "run 7: the new window has the keyboard focus")
    press(keyboard, F4, ALT)
    check(wait_until(lambda: focused(log7) == "restored"), "run 7: closing the new window focused a restored window")
    type_text(keyboard, TYPED[2])
    check(wait_until(lambda: any(TYPED[2] in text for text in draft_texts().values())),
          "run 7: the session saved the text typed after the restore")
    check(all(w in editor_windows() for w in editor6), "run 7: each restored window has the file it had in run 6")
    texts = draft_texts()
    print("Text Editor drafts: %s" % texts)
    check(any(TYPED[2] in texts.get(uri, "") and typed in texts.get(uri, "") for typed, uri in zip(TYPED, file_uris)),
          "run 7: the restored document has the text typed into it in run 6")
    check(all(typed in texts.get(uri, "") for typed, uri in zip(TYPED, file_uris)),
          "run 7: the session kept the draft of each file")
    keyboard.call_sync("Stop", None, Gio.DBusCallFlags.NONE, -1, None)
    # Quitting would ask whether to save the changes, so Text Editor is ended with SIGTERM again.
    proc7.send_signal(signal.SIGTERM)
    try:
        proc7.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc7.kill()
        proc7.wait()
    check(proc7.returncode == -signal.SIGTERM, "run 7: SIGTERM ended Text Editor (status %s)" % proc7.returncode)
    run7 = scan(log7)
    summary(7, run7)
    check(not run7["error"], "run 7: no protocol error")

    calls = []
    calls_path = os.path.join(out, "session-manager.log")
    if os.path.exists(calls_path):
        with open(calls_path) as f:
            calls = [line.split(" ", 1)[0] for line in f]
    print("session manager calls: %s" % (calls or "none"))
    if scenario == "supported":
        check(calls.count("RegisterRestore") == 7, "GTK registered with the session manager in every run")
    else:
        check("RegisterRestore" not in calls, "GTK did not register with the session manager")

    print("RESULT: %s" % ("OK" if not failures else "%d check(s) failed" % len(failures)))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
