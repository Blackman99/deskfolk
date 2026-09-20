import Darwin
import Foundation
import Security

public struct SigningPolicy {
  public let team: String
  public let group: String

  public init(team: String) throws {
    guard team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else {
      throw RemoteError.wrongIdentity
    }
    self.team = team
    self.group = "\(team).com.real-bot.remote"
  }

  public static func current(role: Role) throws -> SigningPolicy {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { throw RemoteError.unsigned }
    let info = try signingInfo(code)
    guard let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
      team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil
    else { throw RemoteError.unsigned }
    let policy = try SigningPolicy(team: team)
    try policy.check(code, role: role)
    if role != .desktop {
      let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any]
      guard let groups = entitlements?["keychain-access-groups"] as? [String],
        groups == [policy.group]
      else { throw RemoteError.entitlement }
    }
    return policy
  }

  public func check(_ code: SecCode, role: Role) throws {
    let identifier: String
    switch role {
    case .daemon: identifier = "com.real-bot.daemon"
    case .desktop: identifier = "com.real-bot.desktop"
    case .helper: identifier = "com.real-bot.runtime-helper"
    }
    let source =
      "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and identifier \"\(identifier)\""
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(source as CFString, [], &requirement) == errSecSuccess,
      SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement)
        == errSecSuccess
    else { throw RemoteError.wrongIdentity }
    let info = try Self.signingInfo(code)
    let flags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
    let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
    // A debuggable or library-injectable process is not a credential principal.
    guard flags & 0x10000 != 0,
      entitlements["com.apple.security.get-task-allow"] as? Bool != true,
      entitlements["com.apple.security.cs.disable-library-validation"] as? Bool != true,
      entitlements["com.apple.security.cs.allow-dyld-environment-variables"] as? Bool != true
    else { throw RemoteError.wrongIdentity }
    if role == .daemon {
      // Stock Bun exposes BUN_BE_BUN before application code; it cannot hold this entitlement.
      guard entitlements["com.real-bot.remote.sealed-runtime-v1"] as? Bool == true else {
        throw RemoteError.runtimeUnsealed
      }
    }
  }

  public func peer(_ fd: Int32, roles: [Role]) throws -> Peer {
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard getpeereid(fd, &uid, &gid) == 0, uid == geteuid() else { throw RemoteError.wrongUser }
    var token = audit_token_t()
    var size = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) == 0,
      size == MemoryLayout<audit_token_t>.size
    else { throw RemoteError.wrongIdentity }
    let bytes = withUnsafeBytes(of: token) { Data($0) }
    var code: SecCode?
    guard
      SecCodeCopyGuestWithAttributes(
        nil, [kSecGuestAttributeAudit: bytes] as CFDictionary, [], &code) == errSecSuccess,
      let code
    else { throw RemoteError.wrongIdentity }
    for role in roles {
      if (try? check(code, role: role)) != nil { return Peer(role: role, identity: bytes) }
    }
    throw RemoteError.wrongIdentity
  }

  private static func signingInfo(_ code: SecCode) throws -> [String: Any] {
    var info: CFDictionary?
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
      SecCodeCopySigningInformation(
        staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
      let info = info as? [String: Any]
    else { throw RemoteError.unsigned }
    return info
  }
}
