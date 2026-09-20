import Foundation

public enum RemoteError: String, Error, Codable {
  case disabled, unsigned
  case wrongIdentity = "wrong_identity"
  case wrongUser = "wrong_user"
  case entitlement
  case runtimeUnsealed = "runtime_unsealed"
  case locked
  case notFound = "not_found"
  case conflict, corrupt, storage
  case version, malformed
  case tooLarge = "too_large"
  case unavailable, busy, timeout
  case authentication, cancelled, expired, proof, rollback
}

public enum Role: String { case daemon, desktop, helper }

public struct Peer: Equatable {
  public let role: Role
  public let identity: Data
  public init(role: Role, identity: Data) {
    self.role = role
    self.identity = identity
  }
}

public struct Action: Codable, Equatable {
  public let kind: String
  public let digest: String
  public let display: String
  public init(kind: String, digest: String, display: String) {
    self.kind = kind
    self.digest = digest
    self.display = display
  }
  public func validate() throws {
    guard ["pair_device", "reset_identity", "change_relay", "change_workspace"].contains(kind),
      digest.count == 64, digest.allSatisfy({ "0123456789abcdef".contains($0) }),
      !display.isEmpty, display.utf8.count <= 1024,
      !display.unicodeScalars.contains(where: {
        CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .format
      })
    else { throw RemoteError.malformed }
  }
}

public struct Request: Codable {
  public let v: Int
  public let id: String
  public let op: String
  public var action: Action?
  public var challenge: String?
  public var proof: String?
  public var material: String?
  public var expected: UInt32?
  public var next: UInt32?
  public init(
    v: Int = 1, id: String, op: String, action: Action? = nil,
    challenge: String? = nil, proof: String? = nil, material: String? = nil,
    expected: UInt32? = nil, next: UInt32? = nil
  ) {
    self.v = v
    self.id = id
    self.op = op
    self.action = action
    self.challenge = challenge
    self.proof = proof
    self.material = material
    self.expected = expected
    self.next = next
  }
  public func validate() throws {
    guard v == 1 else { throw RemoteError.version }
    guard UUID(uuidString: id) != nil else { throw RemoteError.malformed }
  }
}

public struct Response: Codable {
  public var v = 1
  public let id: String
  public var ok: Bool
  public var error: RemoteError?
  public var value: String?
  public var expiresIn: Int?
  public init(id: String, value: String? = nil, expiresIn: Int? = nil) {
    self.id = id
    self.ok = true
    self.value = value
    self.expiresIn = expiresIn
  }
  public init(id: String, error: RemoteError) {
    self.id = id
    self.ok = false
    self.error = error
  }
}

public enum Wire {
  public static let limit = 8192
  public static func decode(_ data: Data) throws -> Request {
    guard data.count <= limit else { throw RemoteError.tooLarge }
    guard let request = try? JSONDecoder().decode(Request.self, from: data) else {
      throw RemoteError.malformed
    }
    try request.validate()
    return request
  }
  public static func encode(_ response: Response) throws -> Data {
    let data = try JSONEncoder().encode(response)
    guard data.count <= limit else { throw RemoteError.tooLarge }
    return data
  }
}
