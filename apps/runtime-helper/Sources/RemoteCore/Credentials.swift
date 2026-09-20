import CryptoKit
import Foundation
import LocalAuthentication
import Security

public protocol CredentialStorage {
  func read() throws -> Data
  func add(_ data: Data) throws
  func replace(_ data: Data, expected: UInt32) throws
}

public struct KeychainStorage: CredentialStorage {
  private let group: String
  public init(policy: SigningPolicy) { group = policy.group }

  private func query() -> [CFString: Any] {
    let context = LAContext()
    context.interactionNotAllowed = true
    return [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: "com.real-bot.remote.v1",
      kSecAttrAccount: "remote-materials-v1",
      kSecAttrAccessGroup: group,
      kSecUseDataProtectionKeychain: true,
      kSecAttrSynchronizable: false,
      kSecUseAuthenticationContext: context,
    ]
  }

  public func read() throws -> Data {
    var query = query()
    query[kSecReturnData] = true
    query[kSecReturnAttributes] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    try Self.check(SecItemCopyMatching(query as CFDictionary, &result))
    guard let item = result as? [String: Any],
      let data = item[kSecValueData as String] as? Data,
      let revision = item[kSecAttrGeneric as String] as? Data,
      let materials = try? JSONDecoder().decode(Materials.self, from: data),
      revision == Self.revision(materials.highwater),
      item[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        as String
    else { throw RemoteError.corrupt }
    return data
  }

  public func add(_ data: Data) throws {
    var query = query()
    let materials = try JSONDecoder().decode(Materials.self, from: data)
    try materials.validate()
    query[kSecValueData] = data
    query[kSecAttrGeneric] = Self.revision(materials.highwater)
    query[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    try Self.check(SecItemAdd(query as CFDictionary, nil))
  }

  public func replace(_ data: Data, expected: UInt32) throws {
    let materials = try JSONDecoder().decode(Materials.self, from: data)
    try materials.validate()
    guard materials.highwater > expected else { throw RemoteError.rollback }
    var query = query()
    // Match inside securityd as well as the file lock, so a replaced lock inode cannot roll back an update.
    query[kSecAttrGeneric] = Self.revision(expected)
    let status = SecItemUpdate(
      query as CFDictionary,
      [
        kSecValueData: data, kSecAttrGeneric: Self.revision(materials.highwater),
      ] as CFDictionary)
    if status == errSecItemNotFound { throw RemoteError.conflict }
    try Self.check(status)
  }

  private static func revision(_ epoch: UInt32) -> Data {
    var value = epoch.bigEndian
    return withUnsafeBytes(of: &value) { Data($0) }
  }

  public static func check(_ status: OSStatus) throws {
    switch status {
    case errSecSuccess: return
    case errSecItemNotFound: throw RemoteError.notFound
    case errSecDuplicateItem: throw RemoteError.conflict
    case errSecInteractionNotAllowed, errSecAuthFailed, errSecNotAvailable: throw RemoteError.locked
    case errSecMissingEntitlement: throw RemoteError.entitlement
    default: throw RemoteError.storage
    }
  }
}

public struct Materials: Codable {
  public let version: Int
  public let hostDH: Data
  public let hostSigning: Data
  public let enrollment: Data
  public let vapid: Data
  public var highwater: UInt32

  public init(
    version: Int, hostDH: Data, hostSigning: Data, enrollment: Data, vapid: Data, highwater: UInt32
  ) {
    self.version = version
    self.hostDH = hostDH
    self.hostSigning = hostSigning
    self.enrollment = enrollment
    self.vapid = vapid
    self.highwater = highwater
  }

  public static func generate(epoch: UInt32) -> Materials {
    Materials(
      version: 1,
      hostDH: Curve25519.KeyAgreement.PrivateKey().rawRepresentation,
      hostSigning: Curve25519.Signing.PrivateKey().rawRepresentation,
      enrollment: Curve25519.Signing.PrivateKey().rawRepresentation,
      vapid: P256.Signing.PrivateKey().rawRepresentation, highwater: epoch)
  }

  public func validate() throws {
    guard version == 1, highwater > 0,
      [hostDH, hostSigning, enrollment, vapid].allSatisfy({ $0.count == 32 })
    else { throw RemoteError.corrupt }
  }
}

public final class Credentials {
  private let storage: CredentialStorage
  private let generate: (UInt32) -> Materials
  public init(
    storage: CredentialStorage, generate: @escaping (UInt32) -> Materials = Materials.generate
  ) {
    self.storage = storage
    self.generate = generate
  }
  public func load() throws -> Materials {
    let data = try storage.read()
    guard data.count <= 4096, let materials = try? JSONDecoder().decode(Materials.self, from: data)
    else { throw RemoteError.corrupt }
    try materials.validate()
    return materials
  }
  public func create() throws {
    let materials = generate(1)
    try materials.validate()
    // One item avoids publishing an identity with only some of its keys persisted.
    try storage.add(JSONEncoder().encode(materials))
  }
  public func reset(expected: UInt32) throws {
    let old = try load()
    guard old.highwater == expected else { throw RemoteError.conflict }
    guard expected < UInt32.max else { throw RemoteError.rollback }
    let materials = generate(expected + 1)
    try materials.validate()
    try storage.replace(JSONEncoder().encode(materials), expected: expected)
  }
  public func advance(expected: UInt32, next: UInt32) throws {
    var materials = try load()
    guard materials.highwater == expected else { throw RemoteError.conflict }
    guard next > expected else { throw RemoteError.rollback }
    materials.highwater = next
    try storage.replace(JSONEncoder().encode(materials), expected: expected)
  }
  public func read(_ material: String) throws -> Data {
    let value = try load()
    switch material {
    case "host_identity": return value.hostDH + value.hostSigning
    case "enrollment": return value.enrollment
    case "vapid": return value.vapid
    case "highwater":
      var epoch = value.highwater.bigEndian
      return withUnsafeBytes(of: &epoch) { Data($0) }
    default: throw RemoteError.malformed
    }
  }
}
