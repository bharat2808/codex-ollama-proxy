import ApplicationServices
import Foundation

guard CommandLine.arguments.count == 2, let port = Int(CommandLine.arguments[1]) else {
    fputs("usage: right-command-push-to-talk PORT\n", stderr)
    exit(64)
}

let baseURL = URL(string: "http://127.0.0.1:\(port)/v1/live/input/")!
var rightCommandDown = false

func send(_ action: String) {
    var request = URLRequest(url: baseURL.appendingPathComponent(action))
    request.httpMethod = "POST"
    URLSession.shared.dataTask(with: request).resume()
}

let callback: CGEventTapCallBack = { _, type, event, _ in
    guard type == .flagsChanged, event.getIntegerValueField(.keyboardEventKeycode) == 54 else {
        return Unmanaged.passUnretained(event)
    }

    if !rightCommandDown {
        rightCommandDown = true
        fputs("Right Command down: recording started.\n", stderr)
        send("start")
    } else {
        rightCommandDown = false
        fputs("Right Command up: recording committed.\n", stderr)
        send("commit")
    }
    return Unmanaged.passUnretained(event)
}

if !CGPreflightListenEventAccess() && !CGRequestListenEventAccess() {
    fputs("Right Command push-to-talk needs macOS Input Monitoring permission.\n", stderr)
    exit(77)
}

let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: mask,
    callback: callback,
    userInfo: nil
) else {
    fputs("Unable to create the Right Command event monitor.\n", stderr)
    exit(1)
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
CFRunLoopRun()
