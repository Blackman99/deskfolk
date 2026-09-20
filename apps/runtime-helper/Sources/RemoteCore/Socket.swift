import Darwin
import Foundation

public enum LocalSocket {
  public static func directory() throws -> String {
    var buffer = [CChar](repeating: 0, count: 1024)
    let count = confstr(_CS_DARWIN_USER_TEMP_DIR, &buffer, buffer.count)
    guard count > 0, count <= buffer.count else {
      throw RemoteError.unavailable
    }
    let root = URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().path
    let path = root + "/real-bot-remote-v1"
    if mkdir(path, 0o700) != 0 && errno != EEXIST { throw RemoteError.unavailable }
    var stat = stat()
    guard lstat(path, &stat) == 0, stat.st_uid == geteuid(),
      stat.st_mode & S_IFMT == S_IFDIR, stat.st_mode & 0o777 == 0o700
    else { throw RemoteError.wrongUser }
    return path
  }

  public static func withCredentialLock<T>(_ body: () throws -> T) throws -> T {
    let fd = open(
      try directory() + "/credentials.lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw RemoteError.storage }
    defer { close(fd) }
    var stat = stat()
    guard fstat(fd, &stat) == 0, stat.st_uid == geteuid(), stat.st_nlink == 1,
      stat.st_mode & S_IFMT == S_IFREG, stat.st_mode & 0o777 == 0o600
    else { throw RemoteError.wrongUser }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw RemoteError.busy }
    defer { flock(fd, LOCK_UN) }
    return try body()
  }

  private static func address(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
      throw RemoteError.unavailable
    }
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    return address
  }

  public static func configure(_ fd: Int32) throws {
    var timeout = timeval(tv_sec: 65, tv_usec: 0)
    var yes: Int32 = 1
    guard
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
      setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0,
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size)) == 0,
      fcntl(fd, F_SETFD, FD_CLOEXEC) == 0
    else { throw RemoteError.unavailable }
  }

  public static func serverLock() throws -> Int32 {
    let fd = open(
      try directory() + "/helper.lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw RemoteError.unavailable }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == geteuid(), info.st_nlink == 1,
      info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o777 == 0o600
    else {
      close(fd)
      throw RemoteError.wrongUser
    }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
      close(fd)
      throw RemoteError.busy
    }
    return fd
  }

  // The caller holds helper.lock for the lifetime of the listener.
  public static func listen() throws -> Int32 {
    let path = try directory() + "/helper.sock"
    var info = stat()
    if lstat(path, &info) == 0 {
      guard info.st_uid == geteuid(), info.st_mode & S_IFMT == S_IFSOCK,
        info.st_mode & 0o777 == 0o600
      else { throw RemoteError.wrongUser }
      guard unlink(path) == 0 else { throw RemoteError.unavailable }
    } else if errno != ENOENT {
      throw RemoteError.unavailable
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw RemoteError.unavailable }
    do {
      try configure(fd)
      var addr = try address(path)
      let result = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
      }
      guard result == 0 else { throw RemoteError.busy }
      guard chmod(path, 0o600) == 0, Darwin.listen(fd, 8) == 0 else {
        unlink(path)
        throw RemoteError.unavailable
      }
      return fd
    } catch {
      close(fd)
      throw error
    }
  }

  public static func call(_ request: Request, policy: SigningPolicy) throws -> Response {
    let path = try directory() + "/helper.sock"
    var stat = stat()
    guard lstat(path, &stat) == 0 else { throw RemoteError.unavailable }
    guard stat.st_uid == geteuid(), stat.st_mode & S_IFMT == S_IFSOCK,
      stat.st_mode & 0o777 == 0o600
    else { throw RemoteError.wrongUser }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw RemoteError.unavailable }
    defer { close(fd) }
    try configure(fd)
    var addr = try address(path)
    let result = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard result == 0 else { throw RemoteError.unavailable }
    _ = try policy.peer(fd, roles: [.helper])
    try send(fd, data: JSONEncoder().encode(request))
    let data = try receive(fd)
    guard let response = try? JSONDecoder().decode(Response.self, from: data), response.v == 1,
      response.id == request.id
    else { throw RemoteError.malformed }
    return response
  }

  public static func receive(_ fd: Int32) throws -> Data {
    let header = try readExactly(fd, count: 4)
    let size = header.reduce(0) { ($0 << 8) | Int($1) }
    guard size > 0, size <= Wire.limit else { throw RemoteError.tooLarge }
    return try readExactly(fd, count: size)
  }

  public static func send(_ fd: Int32, data: Data) throws {
    guard !data.isEmpty, data.count <= Wire.limit else { throw RemoteError.tooLarge }
    var count = UInt32(data.count).bigEndian
    let bytes = withUnsafeBytes(of: &count) { Data($0) } + data
    try bytes.withUnsafeBytes { raw in
      var sent = 0
      while sent < raw.count {
        let n = Darwin.write(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent)
        if n < 0 && errno == EINTR { continue }
        guard n > 0 else { throw RemoteError.unavailable }
        sent += n
      }
    }
  }

  private static func readExactly(_ fd: Int32, count: Int) throws -> Data {
    var data = Data(count: count)
    try data.withUnsafeMutableBytes { raw in
      var read = 0
      while read < count {
        let n = Darwin.read(fd, raw.baseAddress!.advanced(by: read), count - read)
        if n < 0 && errno == EINTR { continue }
        guard n > 0 else { throw RemoteError.timeout }
        read += n
      }
    }
    return data
  }
}
