// A pty for one terminal session, and nothing else.
//
// `forkpty` is the only shape that gets this right on Darwin: the child must call
// `ioctl(TIOCSCTTY)` between fork and exec to acquire a controlling terminal, and
// `posix_spawn` has no hook there. Without a controlling terminal `tcgetpgrp` returns 0,
// so nobody can tell which process group is in the foreground — and zsh puts every job in
// its own group, which makes an interrupt a guess. Hence this binary.
//
// It holds no credentials and asks for no entitlements. Spawning a shell is something the
// person can already do from Terminal.app, so there is nothing here to escalate; that is
// also why it is its own product rather than a subcommand of the credential helper.
//
//   real-bot-pty --rows 24 --cols 80 --cwd /path -- /bin/zsh -l
//
// stdin  — control frames: [type:u8][len:u32be][payload]
//            1 input (raw bytes)  2 resize (rows:u16be, cols:u16be)  3 signal (signo:u8)
//            4 shut down (empty)
//          EOF means the daemon is gone, and means the same thing as frame 4.
// stdout — raw pty output, unframed.
// exit   — the child's status, so the caller sees the real exit code.
import Darwin
import Foundation

func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write(Data("real-bot-pty: \(message)\n".utf8))
  exit(code)
}

var rows: UInt16 = 24
var cols: UInt16 = 80
var cwd = FileManager.default.currentDirectoryPath
var command: [String] = []
var argIndex = 1
let args = CommandLine.arguments
while argIndex < args.count {
  switch args[argIndex] {
  case "--rows":
    argIndex += 1
    rows = UInt16(args[safe: argIndex].flatMap { UInt16($0) } ?? 24)
  case "--cols":
    argIndex += 1
    cols = UInt16(args[safe: argIndex].flatMap { UInt16($0) } ?? 80)
  case "--cwd":
    argIndex += 1
    cwd = args[safe: argIndex] ?? cwd
  case "--":
    command = Array(args.dropFirst(argIndex + 1))
    argIndex = args.count
  default:
    fail("unknown argument \(args[argIndex])", 64)
  }
  argIndex += 1
}
extension Array {
  subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
if command.isEmpty { fail("no command", 64) }

// Everything the child touches between fork and exec has to exist before the fork: only
// async-signal-safe calls are legal there, which rules out allocation and Foundation.
let childArgv: [UnsafeMutablePointer<CChar>?] = command.map { strdup($0) } + [nil]
let childPath = strdup(command[0])
let childCwd = strdup(cwd)

signal(SIGPIPE, SIG_IGN)

var master: Int32 = 0
var size = winsize(ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0)
let child = forkpty(&master, nil, nil, &size)
if child < 0 { fail("forkpty failed: \(String(cString: strerror(errno)))", 70) }
if child == 0 {
  // forkpty already did setsid, TIOCSCTTY and the dup2s. Only the cwd is left.
  if chdir(childCwd) != 0 { _exit(126) }
  execv(childPath, childArgv)
  _exit(127)
}

/// Reads exactly `count` bytes, or returns nil once the pipe closes.
func readExactly(_ fd: Int32, _ count: Int) -> [UInt8]? {
  if count == 0 { return [] }
  var buffer = [UInt8](repeating: 0, count: count)
  var filled = 0
  while filled < count {
    let got = buffer.withUnsafeMutableBytes { raw -> Int in
      read(fd, raw.baseAddress!.advanced(by: filled), count - filled)
    }
    if got == 0 { return nil }
    if got < 0 {
      if errno == EINTR { continue }
      return nil
    }
    filled += got
  }
  return buffer
}

func writeAll(_ fd: Int32, _ bytes: UnsafeRawPointer, _ count: Int) {
  var written = 0
  while written < count {
    let put = write(fd, bytes.advanced(by: written), count - written)
    if put <= 0 {
      if put < 0 && errno == EINTR { continue }
      return
    }
    written += put
  }
}

/// Signals go to the tty's foreground process group, not to the shell: an interrupt is meant
/// for whatever is running right now, and the shell should survive it.
func deliver(_ signo: Int32) {
  let foreground = tcgetpgrp(master)
  if foreground > 0 { killpg(foreground, signo) } else { kill(child, signo) }
}

/// Ending the session, and meaning it.
///
/// A hangup alone is a request: a login shell may have SIGHUP ignored, and then closing the
/// terminal would leave a shell running with nothing attached to it — which is exactly what
/// happened before this existed. So ask, wait, and then insist. The child is its own session and
/// process-group leader (forkpty saw to that), so its pgid is its pid.
func shutdown() -> Never {
  deliver(SIGHUP)
  kill(child, SIGHUP)
  for _ in 0..<20 {
    var status: Int32 = 0
    if waitpid(child, &status, WNOHANG) == child { exit(0) }
    usleep(100_000)
  }
  killpg(child, SIGKILL)
  kill(child, SIGKILL)
  var status: Int32 = 0
  while waitpid(child, &status, 0) < 0 && errno == EINTR {}
  exit(0)
}

// A daemon that is going away sends SIGTERM as well as closing the pipe; both mean the same thing.
signal(SIGTERM, SIG_IGN)
signal(SIGHUP, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
termSource.setEventHandler { shutdown() }
termSource.resume()
let hupSource = DispatchSource.makeSignalSource(signal: SIGHUP, queue: .global())
hupSource.setEventHandler { shutdown() }
hupSource.resume()

let control = DispatchQueue(label: "com.real-bot.pty.control")
control.async {
  while true {
    guard let header = readExactly(0, 5) else { break }
    let length = Int(header[1]) << 24 | Int(header[2]) << 16 | Int(header[3]) << 8 | Int(header[4])
    if length > 1 << 20 { break }
    guard let payload = readExactly(0, length) else { break }
    switch header[0] {
    case 1:
      payload.withUnsafeBytes { raw in
        if let base = raw.baseAddress { writeAll(master, base, payload.count) }
      }
    case 2:
      if payload.count == 4 {
        var next = winsize(
          ws_row: UInt16(payload[0]) << 8 | UInt16(payload[1]),
          ws_col: UInt16(payload[2]) << 8 | UInt16(payload[3]),
          ws_xpixel: 0, ws_ypixel: 0)
        _ = ioctl(master, TIOCSWINSZ, &next)
      }
    case 3:
      if payload.count == 1 { deliver(Int32(payload[0])) }
    case 4:
      shutdown()
    default:
      break
    }
  }
  // The pipe closed: the daemon is gone, and an orphaned shell helps nobody.
  shutdown()
}

var buffer = [UInt8](repeating: 0, count: 8192)
while true {
  let got = buffer.withUnsafeMutableBytes { raw in read(master, raw.baseAddress!, 8192) }
  if got > 0 {
    buffer.withUnsafeBytes { raw in writeAll(1, raw.baseAddress!, got) }
    continue
  }
  if got < 0 && errno == EINTR { continue }
  break  // EIO once the child is gone
}

var status: Int32 = 0
while waitpid(child, &status, 0) < 0 && errno == EINTR {}
if status & 0x7f != 0 { exit(128 + (status & 0x7f)) }
exit((status >> 8) & 0xff)
