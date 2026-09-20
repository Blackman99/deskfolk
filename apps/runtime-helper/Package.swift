// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "RuntimeHelper",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "real-bot-runtime-helper", targets: ["RuntimeHelper"]),
    .library(name: "RemoteCredentials", type: .dynamic, targets: ["RemoteCredentials"]),
  ],
  targets: [
    .target(name: "RemoteCore"),
    .target(name: "RemoteCredentials", dependencies: ["RemoteCore"]),
    .executableTarget(name: "RuntimeHelper", dependencies: ["RemoteCore"]),
    .executableTarget(
      name: "RemoteCoreTests", dependencies: ["RemoteCore"], path: "Tests/RemoteCoreTests"),
  ],
  swiftLanguageModes: [.v5]
)
