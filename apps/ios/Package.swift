// swift-tools-version: 5.7
import PackageDescription

let package = Package(
    name: "RemoteCodex",
    platforms: [
        // SwiftPM 只声明主版本；迁移到 Xcode 工程时将部署目标固定为 iOS 16.3。
        .iOS(.v16)
    ],
    products: [
        .library(name: "RemoteCodexCore", targets: ["RemoteCodexCore"]),
        .executable(name: "RemoteCodexApp", targets: ["RemoteCodexApp"])
    ],
    targets: [
        .target(
            name: "RemoteCodexCore",
            linkerSettings: [
                .linkedFramework("Security", condition: .when(platforms: [.iOS, .macOS]))
            ]
        ),
        .executableTarget(name: "RemoteCodexApp", dependencies: ["RemoteCodexCore"]),
        .testTarget(name: "RemoteCodexCoreTests", dependencies: ["RemoteCodexCore"])
    ]
)
