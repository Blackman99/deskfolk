import Darwin
import Foundation
import RemoteCore

umask(0o077)

do {
  let policy = try SigningPolicy.current(role: .helper)
  let service = HelperService(
    credentials: Credentials(storage: KeychainStorage(policy: policy)), auth: MacAuthenticator())
  let ownership = try LocalSocket.serverLock()
  defer { close(ownership) }
  let fd = try LocalSocket.listen()
  defer { close(fd) }
  let slots = DispatchSemaphore(value: 8)
  while true {
    let client = accept(fd, nil, nil)
    if client < 0 {
      if errno == EINTR { continue }
      throw RemoteError.unavailable
    }
    guard slots.wait(timeout: .now()) == .success else {
      close(client)
      continue
    }
    DispatchQueue.global().async {
      defer {
        close(client)
        slots.signal()
      }
      var id = ""
      do {
        try LocalSocket.configure(client)
        let peer = try policy.peer(client, roles: [.daemon, .desktop])
        let request = try Wire.decode(LocalSocket.receive(client))
        id = request.id
        let response = try LocalSocket.withCredentialLock { service.handle(request, peer: peer) }
        try LocalSocket.send(client, data: Wire.encode(response))
      } catch let error as RemoteError {
        try? LocalSocket.send(client, data: Wire.encode(Response(id: id, error: error)))
      } catch {
        try? LocalSocket.send(client, data: Wire.encode(Response(id: id, error: .unavailable)))
      }
    }
  }
} catch let error as RemoteError {
  FileHandle.standardError.write(Data("runtime-helper: \(error.rawValue)\n".utf8))
  exit(1)
} catch {
  FileHandle.standardError.write(Data("runtime-helper: unavailable\n".utf8))
  exit(1)
}
