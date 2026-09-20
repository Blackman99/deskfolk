import Foundation
import LocalAuthentication
import Security
import SystemConfiguration

public protocol LocalAuthenticator {
  func authenticate(action: Action) throws
}

public struct MacAuthenticator: LocalAuthenticator {
  public init() {}
  public func authenticate(action: Action) throws {
    var uid: uid_t = 0
    guard SCDynamicStoreCopyConsoleUser(nil, &uid, nil) != nil, uid == geteuid(), uid != 0
    else { throw RemoteError.unavailable }
    let started = HelperService.clock()
    let context = LAContext()
    context.touchIDAuthenticationAllowableReuseDuration = 0
    defer { context.invalidate() }
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      throw RemoteError.authentication
    }
    let done = DispatchSemaphore(value: 0)
    let resultLock = NSLock()
    var success = false
    var failure: Error?
    context.evaluatePolicy(
      .deviceOwnerAuthentication,
      localizedReason: "Real Bot: \(action.kind)\n\(action.display)\nSHA-256: \(action.digest)"
    ) { ok, error in
      resultLock.lock()
      success = ok
      failure = error
      resultLock.unlock()
      done.signal()
    }
    guard done.wait(timeout: .now() + 60) == .success,
      HelperService.clock() - started < 60
    else { throw RemoteError.expired }
    resultLock.lock()
    defer { resultLock.unlock() }
    if !success {
      let code = (failure as? LAError)?.code
      if code == .userCancel || code == .appCancel || code == .systemCancel {
        throw RemoteError.cancelled
      }
      throw RemoteError.authentication
    }
  }
}

public final class HelperService {
  private struct Pending {
    let owner: Peer
    let action: Action
    let deadline: TimeInterval
    var token: String?
    var confirmedAt: TimeInterval?
  }
  private var pending: [String: Pending] = [:]
  private let lock = NSLock()
  private let credentials: Credentials
  private let auth: LocalAuthenticator
  private let now: () -> TimeInterval
  private let random: () throws -> String

  public init(
    credentials: Credentials, auth: LocalAuthenticator,
    now: @escaping () -> TimeInterval = HelperService.clock,
    random: @escaping () throws -> String = HelperService.randomToken
  ) {
    self.credentials = credentials
    self.auth = auth
    self.now = now
    self.random = random
  }

  public static func clock() -> TimeInterval {
    var time = timespec()
    clock_gettime(CLOCK_MONOTONIC_RAW, &time)
    return Double(time.tv_sec) + Double(time.tv_nsec) / 1_000_000_000
  }

  public static func randomToken() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess
    else { throw RemoteError.unavailable }
    return Data(bytes).base64EncodedString()
  }

  public func handle(_ request: Request, peer: Peer) -> Response {
    guard lock.try() else { return Response(id: request.id, error: .busy) }
    defer { lock.unlock() }
    do {
      try request.validate()
      switch request.op {
      case "ping":
        return Response(id: request.id)
      case "prepare":
        guard peer.role == .daemon else { throw RemoteError.wrongIdentity }
        guard let action = request.action else { throw RemoteError.malformed }
        try action.validate()
        pending = pending.filter { $0.value.deadline > now() }
        guard pending.count < 16 else { throw RemoteError.busy }
        let challenge = try random()
        pending[challenge] = Pending(owner: peer, action: action, deadline: now() + 120)
        return Response(id: request.id, value: challenge, expiresIn: 120)
      case "confirm":
        guard peer.role == .desktop else { throw RemoteError.wrongIdentity }
        guard let challenge = request.challenge, var entry = pending[challenge] else {
          throw RemoteError.proof
        }
        guard entry.deadline > now() else {
          pending.removeValue(forKey: challenge)
          throw RemoteError.expired
        }
        guard entry.token == nil else { throw RemoteError.conflict }
        // The displayed action comes from the authenticated daemon, never the webview.
        do { try auth.authenticate(action: entry.action) } catch {
          pending.removeValue(forKey: challenge)
          throw error
        }
        guard entry.deadline > now() else {
          pending.removeValue(forKey: challenge)
          throw RemoteError.expired
        }
        let confirmedAt = now()
        _ = try credentials.load()
        entry.token = try random()
        entry.confirmedAt = confirmedAt
        let finishedAt = now()
        let remaining = min(confirmedAt + 60, entry.deadline) - finishedAt
        guard finishedAt >= confirmedAt, remaining >= 1 else {
          pending.removeValue(forKey: challenge)
          throw RemoteError.expired
        }
        pending[challenge] = entry
        return Response(
          id: request.id, value: entry.token, expiresIn: Int(remaining.rounded(.down)))
      case "consume", "reset":
        guard peer.role == .daemon else { throw RemoteError.wrongIdentity }
        guard let challenge = request.challenge, let entry = pending[challenge],
          entry.owner == peer, entry.action == request.action,
          let token = entry.token, token == request.proof
        else { throw RemoteError.proof }
        pending.removeValue(forKey: challenge)
        guard let confirmed = entry.confirmedAt, now() >= confirmed,
          now() - confirmed < 60, entry.deadline > now()
        else { throw RemoteError.expired }
        if request.op == "reset" {
          guard entry.action.kind == "reset_identity", let expected = request.expected else {
            throw RemoteError.malformed
          }
          try credentials.reset(expected: expected)
        } else {
          _ = try credentials.load()
        }
        return Response(id: request.id)
      case "create":
        guard peer.role == .desktop else { throw RemoteError.wrongIdentity }
        do {
          _ = try credentials.load()
          throw RemoteError.conflict
        } catch RemoteError.notFound {}  // Locked or corrupt items are never replaced.
        try auth.authenticate(
          action: Action(
            kind: "reset_identity", digest: String(repeating: "0", count: 64),
            display: "Create the first remote identity on this Mac"))
        try credentials.create()
        return Response(id: request.id)
      default: throw RemoteError.malformed
      }
    } catch let error as RemoteError { return Response(id: request.id, error: error) } catch {
      return Response(id: request.id, error: .unavailable)
    }
  }
}
