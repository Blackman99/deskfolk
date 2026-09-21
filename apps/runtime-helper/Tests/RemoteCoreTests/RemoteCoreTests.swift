import Darwin
import Foundation
import RemoteCore

private var failures = 0
private func expect(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) {
  if !value {
    failures += 1
    print("FAILED \(file):\(line)")
  }
}
private func expectEqual<T: Equatable>(
  _ value: T, _ expected: T, file: StaticString = #filePath, line: UInt = #line
) {
  expect(value == expected, file: file, line: line)
}
private func expectThrows<T>(
  _ body: @autoclosure () throws -> T, file: StaticString = #filePath, line: UInt = #line,
  _ check: (Error) -> Void = { _ in }
) {
  do {
    _ = try body()
    expect(false, file: file, line: line)
  } catch { check(error) }
}

private final class MemoryStorage: CredentialStorage {
  var value: Data?
  var failure: RemoteError?
  var duringRead: (() -> Void)?
  func read() throws -> Data {
    duringRead?()
    if let failure { throw failure }
    guard let value else { throw RemoteError.notFound }
    return value
  }
  func add(_ data: Data) throws {
    if let failure { throw failure }
    guard value == nil else { throw RemoteError.conflict }
    value = data
  }
  func replace(_ data: Data, expected: UInt32) throws {
    if let failure { throw failure }
    guard let value else { throw RemoteError.notFound }
    guard try JSONDecoder().decode(Materials.self, from: value).highwater == expected else {
      throw RemoteError.conflict
    }
    self.value = data
  }
}

private final class FakeAuth: LocalAuthenticator {
  var failure: RemoteError?
  var seen: [Action] = []
  var during: (() -> Void)?
  func authenticate(action: Action) throws {
    seen.append(action)
    during?()
    if let failure { throw failure }
  }
}

final class RemoteCoreTests {
  private let daemon = Peer(role: .daemon, identity: Data([1]))
  private let desktop = Peer(role: .desktop, identity: Data([2]))
  private let action = Action(
    kind: "pair_device", digest: String(repeating: "a", count: 64),
    display: "Fixture device fingerprint")

  private func credentials(_ storage: MemoryStorage) -> Credentials {
    Credentials(storage: storage) { epoch in
      Materials(
        version: 1, hostDH: Data(repeating: 1, count: 32),
        hostSigning: Data(repeating: 2, count: 32),
        enrollment: Data(repeating: 3, count: 32), vapid: Data(repeating: 4, count: 32),
        highwater: epoch)
    }
  }
  private func request(
    _ op: String, action: Action? = nil, challenge: String? = nil, proof: String? = nil
  ) -> Request {
    Request(id: UUID().uuidString, op: op, action: action, challenge: challenge, proof: proof)
  }
  private func fixture() throws -> (MemoryStorage, Credentials, FakeAuth) {
    let storage = MemoryStorage()
    let keys = credentials(storage)
    try keys.create()
    return (storage, keys, FakeAuth())
  }

  func testMaterialsAreAtomicAndNeverOverwriteOnCreateOrFailure() throws {
    let (storage, keys, _) = try fixture()
    let original = storage.value
    expectThrows(try keys.create()) { expectEqual($0 as? RemoteError, .conflict) }
    expectEqual(try keys.read("host_identity").count, 64)
    expectEqual(try keys.read("highwater"), Data([0, 0, 0, 1]))
    expectThrows(try keys.read("endpoint-api-key"))
    storage.failure = .locked
    expectThrows(try keys.advance(expected: 1, next: 2))
    expectEqual(storage.value, original)
    storage.failure = nil
    storage.value = Data("invalid".utf8)
    expectThrows(try keys.load()) { expectEqual($0 as? RemoteError, .corrupt) }
  }

  func testHighwaterSurvivesNewServiceAndRejectsRollbackAndStaleWriter() throws {
    let (storage, keys, _) = try fixture()
    try keys.advance(expected: 1, next: 4)
    let restarted = credentials(storage)
    expectEqual(try restarted.load().highwater, 4)
    expectThrows(try restarted.advance(expected: 1, next: 5)) {
      expectEqual($0 as? RemoteError, .conflict)
    }
    expectThrows(try restarted.advance(expected: 4, next: 3)) {
      expectEqual($0 as? RemoteError, .rollback)
    }
    try restarted.reset(expected: 4)
    expectEqual(try restarted.load().highwater, 5)
  }

  func testFreshActionBoundProofHasOneConsumerAndProcessOwner() throws {
    let (_, keys, auth) = try fixture()
    let service = HelperService(credentials: keys, auth: auth)
    let challenge = service.handle(request("prepare", action: action), peer: daemon).value!
    expectEqual(
      service.handle(request("confirm", challenge: challenge), peer: daemon).error, .wrongIdentity)
    let proof = service.handle(request("confirm", challenge: challenge), peer: desktop).value!
    expectEqual(auth.seen, [action])
    let consume = request("consume", action: action, challenge: challenge, proof: proof)
    expectEqual(
      service.handle(consume, peer: Peer(role: .daemon, identity: Data([3]))).error, .proof)
    expectEqual(
      service.handle(
        request("consume", action: action, challenge: challenge, proof: "wrong"), peer: daemon
      ).error, .proof)
    let other = Action(kind: "change_relay", digest: action.digest, display: action.display)
    expectEqual(
      service.handle(
        request("consume", action: other, challenge: challenge, proof: proof), peer: daemon
      ).error, .proof)
    expect(service.handle(consume, peer: daemon).ok)
    expectEqual(service.handle(consume, peer: daemon).error, .proof)
  }

  func testProofExpiresAndCancellationNeverCreatesProof() throws {
    let (_, keys, auth) = try fixture()
    var now = 10.0
    let service = HelperService(credentials: keys, auth: auth, now: { now })
    let challenge = service.handle(request("prepare", action: action), peer: daemon).value!
    let proof = service.handle(request("confirm", challenge: challenge), peer: desktop).value!
    now += 60
    expectEqual(
      service.handle(
        request("consume", action: action, challenge: challenge, proof: proof), peer: daemon
      ).error, .expired)
    let cancelled = service.handle(request("prepare", action: action), peer: daemon).value!
    auth.failure = .cancelled
    expectEqual(
      service.handle(request("confirm", challenge: cancelled), peer: desktop).error, .cancelled)
    expectEqual(
      service.handle(request("confirm", challenge: cancelled), peer: desktop).error, .proof)
  }

  func testConcurrentConfirmationReturnsBusyAndLockedKeychainFailsClosed() throws {
    let (storage, keys, auth) = try fixture()
    let service = HelperService(credentials: keys, auth: auth)
    let challenge = service.handle(request("prepare", action: action), peer: daemon).value!
    auth.during = {
      expectEqual(
        service.handle(self.request("confirm", challenge: challenge), peer: self.desktop).error,
        .busy)
    }
    storage.failure = .locked
    expectEqual(
      service.handle(request("confirm", challenge: challenge), peer: desktop).error, .locked)
  }

  func testActionKindsAcceptRemovalRenewalAndRecoveryWithoutReplacingPairing() throws {
    let (_, keys, auth) = try fixture()
    let service = HelperService(credentials: keys, auth: auth)
    try action.validate()
    for kind in ["remove_device", "renew_first_uv", "recover_trust"] {
      let next = Action(kind: kind, digest: action.digest, display: action.display)
      try next.validate()
      expect(service.handle(request("prepare", action: next), peer: daemon).ok)
    }
    expectThrows(
      try Action(kind: "unknown_kind", digest: action.digest, display: action.display).validate()
    ) { expectEqual($0 as? RemoteError, .malformed) }
    expectEqual(
      service.handle(
        request(
          "prepare",
          action: Action(
            kind: "unknown_kind", digest: action.digest, display: action.display)), peer: daemon
      ).error, .malformed)
  }

  func testProtocolLimitsAndRoleSeparation() throws {
    let (_, keys, auth) = try fixture()
    let service = HelperService(credentials: keys, auth: auth)
    expectEqual(
      service.handle(request("prepare", action: action), peer: desktop).error, .wrongIdentity)
    expectEqual(service.handle(request("read"), peer: desktop).error, .malformed)
    let bad = Request(v: 2, id: UUID().uuidString, op: "create")
    expectThrows(try Wire.decode(JSONEncoder().encode(bad))) {
      expectEqual($0 as? RemoteError, .version)
    }
    expectThrows(try Wire.decode(Data(repeating: 0, count: 8193)))
    expectThrows(try Wire.decode(Data("{}".utf8)))
    expect(auth.seen.isEmpty)
  }

  func testSocketFramingWithGeneratedFixtureOnly() throws {
    var fds: [Int32] = [0, 0]
    expectEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
    defer {
      close(fds[0])
      close(fds[1])
    }
    let data = try JSONEncoder().encode(request("prepare", action: action))
    try LocalSocket.send(fds[0], data: data)
    expectEqual(try Wire.decode(LocalSocket.receive(fds[1])).op, "prepare")
    var tooLarge: UInt32 = UInt32(Wire.limit + 1).bigEndian
    withUnsafeBytes(of: &tooLarge) { _ = Darwin.write(fds[0], $0.baseAddress, $0.count) }
    expectThrows(try LocalSocket.receive(fds[1])) { expectEqual($0 as? RemoteError, .tooLarge) }
  }

  func testHelperCreationAndResetRequireFreshProof() throws {
    let storage = MemoryStorage()
    let keys = credentials(storage)
    let auth = FakeAuth()
    let service = HelperService(credentials: keys, auth: auth)
    expectEqual(service.handle(request("create"), peer: daemon).error, .wrongIdentity)
    auth.failure = .cancelled
    expectEqual(service.handle(request("create"), peer: desktop).error, .cancelled)
    expect(storage.value == nil)
    auth.failure = nil
    expect(service.handle(request("create"), peer: desktop).ok)
    let count = auth.seen.count
    expectEqual(service.handle(request("create"), peer: desktop).error, .conflict)
    expectEqual(auth.seen.count, count)
    let reset = Action(
      kind: "reset_identity", digest: action.digest, display: "Reset fixture identity")
    let challenge = service.handle(request("prepare", action: reset), peer: daemon).value!
    let proof = service.handle(request("confirm", challenge: challenge), peer: desktop).value!
    var resetRequest = request("reset", action: reset, challenge: challenge, proof: proof)
    resetRequest.expected = 1
    expect(service.handle(resetRequest, peer: daemon).ok)
    expectEqual(try keys.load().highwater, 2)
    expectEqual(service.handle(resetRequest, peer: daemon).error, .proof)
  }

  func testFailedWritesDoNotClaimDurabilityAndPendingChallengesAreBounded() throws {
    let (storage, keys, auth) = try fixture()
    let original = storage.value
    storage.failure = .storage
    expectThrows(try keys.reset(expected: 1))
    expectEqual(storage.value, original)
    storage.failure = nil
    let service = HelperService(credentials: keys, auth: auth)
    for _ in 0..<16 { expect(service.handle(request("prepare", action: action), peer: daemon).ok) }
    expectEqual(service.handle(request("prepare", action: action), peer: daemon).error, .busy)
    expect(auth.seen.isEmpty)
  }

  func testExpiredPromptAndLockedConsumptionNeverAuthorize() throws {
    let (storage, keys, auth) = try fixture()
    var now = 0.0
    let service = HelperService(credentials: keys, auth: auth, now: { now })
    let expired = service.handle(request("prepare", action: action), peer: daemon).value!
    auth.during = { now += 121 }
    expectEqual(
      service.handle(request("confirm", challenge: expired), peer: desktop).error, .expired)
    auth.during = nil
    let challenge = service.handle(request("prepare", action: action), peer: daemon).value!
    let proof = service.handle(request("confirm", challenge: challenge), peer: desktop).value!
    storage.failure = .locked
    expectEqual(
      service.handle(
        request("consume", action: action, challenge: challenge, proof: proof), peer: daemon
      ).error, .locked)
    storage.failure = nil
    expectEqual(
      service.handle(
        request("consume", action: action, challenge: challenge, proof: proof), peer: daemon
      ).error, .proof)
  }

  func testConfirmationReportsRemainingChallengeAndProofLifetime() throws {
    for (begin, authTime, storeTime, expected) in [
      (100.0, 0.0, 0.0, 20), (90.0, 10.0, 3.25, 16), (0.0, 5.0, 2.25, 57),
    ] {
      let (storage, keys, auth) = try fixture()
      var now = 0.0
      let service = HelperService(credentials: keys, auth: auth, now: { now })
      let challenge = service.handle(request("prepare", action: action), peer: daemon).value!
      now = begin
      auth.during = { now += authTime }
      storage.duringRead = { now += storeTime }
      let confirmation = service.handle(request("confirm", challenge: challenge), peer: desktop)
      expect(confirmation.ok)
      expectEqual(confirmation.expiresIn, expected)
      storage.duringRead = nil
      now += Double(expected) - 0.1
      expect(
        service.handle(
          request("consume", action: action, challenge: challenge, proof: confirmation.value),
          peer: daemon
        ).ok)
    }
  }

  func testConfirmationRejectsExpiryDuringStoreOrTokenGeneration() throws {
    for (begin, storeTime, randomTime) in [
      (100.0, 20.0, 0.0), (0.0, 60.0, 0.0), (119.5, 0.0, 0.0), (100.0, 0.0, 20.0),
    ] {
      let (storage, keys, auth) = try fixture()
      var now = 0.0
      var draws = 0
      let service = HelperService(
        credentials: keys, auth: auth, now: { now },
        random: {
          draws += 1
          if draws == 2 { now += randomTime }
          return Data(repeating: UInt8(draws), count: 32).base64EncodedString()
        })
      let challenge = service.handle(request("prepare", action: action), peer: daemon).value!
      now = begin
      storage.duringRead = { now += storeTime }
      let response = service.handle(request("confirm", challenge: challenge), peer: desktop)
      expectEqual(response.error, .expired)
      expect(response.value == nil)
      expectEqual(
        service.handle(request("confirm", challenge: challenge), peer: desktop).error, .proof)
    }
  }

  func testKeychainStatusClassificationWithoutKeychainCalls() {
    expectThrows(try KeychainStorage.check(-25308)) { expectEqual($0 as? RemoteError, .locked) }
    expectThrows(try KeychainStorage.check(-25300)) { expectEqual($0 as? RemoteError, .notFound) }
    expectThrows(try KeychainStorage.check(-34018)) {
      expectEqual($0 as? RemoteError, .entitlement)
    }
    expectThrows(try KeychainStorage.check(-1)) { expectEqual($0 as? RemoteError, .storage) }
  }

  func testUnsignedTestProcessCannotBecomeCredentialPrincipal() {
    expectThrows(try SigningPolicy.current(role: .daemon))
    expectThrows(try SigningPolicy.current(role: .helper))
    var fds: [Int32] = [0, 0]
    expectEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
    defer {
      close(fds[0])
      close(fds[1])
    }
    let policy = try! SigningPolicy(team: "AAAAAAAAAA")
    expectThrows(try policy.peer(fds[0], roles: [.daemon, .desktop]))
  }
}

@main
struct TestRunner {
  static func main() throws {
    let tests = RemoteCoreTests()
    try tests.testMaterialsAreAtomicAndNeverOverwriteOnCreateOrFailure()
    try tests.testHighwaterSurvivesNewServiceAndRejectsRollbackAndStaleWriter()
    try tests.testFreshActionBoundProofHasOneConsumerAndProcessOwner()
    try tests.testProofExpiresAndCancellationNeverCreatesProof()
    try tests.testConcurrentConfirmationReturnsBusyAndLockedKeychainFailsClosed()
    try tests.testActionKindsAcceptRemovalRenewalAndRecoveryWithoutReplacingPairing()
    try tests.testProtocolLimitsAndRoleSeparation()
    try tests.testSocketFramingWithGeneratedFixtureOnly()
    tests.testUnsignedTestProcessCannotBecomeCredentialPrincipal()
    try tests.testHelperCreationAndResetRequireFreshProof()
    try tests.testFailedWritesDoNotClaimDurabilityAndPendingChallengesAreBounded()
    tests.testKeychainStatusClassificationWithoutKeychainCalls()
    try tests.testExpiredPromptAndLockedConsumptionNeverAuthorize()
    try tests.testConfirmationReportsRemainingChallengeAndProofLifetime()
    try tests.testConfirmationRejectsExpiryDuringStoreOrTokenGeneration()
    guard failures == 0 else { exit(1) }
    print("15 native fixture tests passed; no Keychain or LA calls.")
  }
}
