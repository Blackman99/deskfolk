import Foundation
import RemoteCore

// Caller-owned buffers keep key bytes out of C strings and allocator ownership across FFI.
@_cdecl("rb_remote_call_v1")
public func remoteCall(
  _ input: UnsafePointer<UInt8>?, _ count: Int32,
  _ output: UnsafeMutablePointer<UInt8>?, _ capacity: Int32
) -> Int32 {
  guard let input, let output, count > 0, count <= Wire.limit, capacity >= Wire.limit else {
    return -1
  }
  var id = ""
  let response: Response
  do {
    let request = try Wire.decode(Data(bytes: input, count: Int(count)))
    id = request.id
    let role: Role
    let policy: SigningPolicy
    do {
      policy = try SigningPolicy.current(role: .daemon)
      role = .daemon
    } catch let error as RemoteError where error == .wrongIdentity {
      policy = try SigningPolicy.current(role: .desktop)
      role = .desktop
    }
    let credentials = Credentials(storage: KeychainStorage(policy: policy))
    switch request.op {
    case "capability":
      response = Response(id: id, value: "signed_native_available_g_pack_not_verified")
    case "read":
      guard role == .daemon, let material = request.material else {
        throw RemoteError.wrongIdentity
      }
      let value = try LocalSocket.withCredentialLock { try credentials.read(material) }
      response = Response(id: id, value: value.base64EncodedString())
    case "advance_highwater":
      guard role == .daemon, let expected = request.expected, let next = request.next else {
        throw RemoteError.wrongIdentity
      }
      try LocalSocket.withCredentialLock { try credentials.advance(expected: expected, next: next) }
      response = Response(id: id)
    case "prepare", "consume", "reset":
      guard role == .daemon else { throw RemoteError.wrongIdentity }
      response = try LocalSocket.call(request, policy: policy)
    case "confirm", "create", "ping":
      guard role == .desktop else { throw RemoteError.wrongIdentity }
      response = try LocalSocket.call(request, policy: policy)
    default: throw RemoteError.malformed
    }
  } catch let error as RemoteError { response = Response(id: id, error: error) } catch {
    response = Response(id: id, error: .unavailable)
  }
  guard let data = try? Wire.encode(response), data.count <= Int(capacity) else { return -1 }
  data.copyBytes(to: output, count: data.count)
  return Int32(data.count)
}
