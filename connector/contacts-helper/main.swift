// Reads the owner's Contacts and writes number/email -> name to the file it is given, then quits. It has the
// Contacts permission and nothing else; the connector, which talks to the network, never has it.
import Contacts
import Foundation

func write(_ names: [String: String], to path: String) throws {
  let data = try JSONSerialization.data(withJSONObject: ["names": names], options: [.sortedKeys])
  let url = URL(fileURLWithPath: path)
  let temp = url.deletingLastPathComponent().appendingPathComponent(".contacts-\(getpid()).tmp")
  FileManager.default.createFile(atPath: temp.path, contents: data, attributes: [.posixPermissions: 0o600])
  if rename(temp.path, url.path) != 0 { throw CocoaError(.fileWriteUnknown) }
}

func main() -> Int32 {
  guard CommandLine.arguments.count == 2 else {
    fputs("usage: J-Inbox Contacts <output file>\n", stderr)
    return 2
  }
  let store = CNContactStore()
  let done = DispatchSemaphore(value: 0)
  var allowed = false
  store.requestAccess(for: .contacts) { ok, _ in
    allowed = ok
    done.signal()
  }
  done.wait()
  guard allowed else {
    fputs("Contacts access was not allowed\n", stderr)
    return 1
  }
  let keys: [CNKeyDescriptor] = [
    CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
    CNContactOrganizationNameKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
  ]
  var names: [String: String] = [:]
  do {
    try store.enumerateContacts(with: CNContactFetchRequest(keysToFetch: keys)) { c, _ in
      let name = CNContactFormatter.string(from: c, style: .fullName) ?? c.organizationName
      guard !name.isEmpty else { return }
      for p in c.phoneNumbers where names[p.value.stringValue] == nil { names[p.value.stringValue] = name }
      for e in c.emailAddresses where names[e.value as String] == nil { names[e.value as String] = name }
    }
    try write(names, to: CommandLine.arguments[1])
    return 0
  } catch {
    fputs("Could not read Contacts: \(error)\n", stderr)
    return 1
  }
}

exit(main())
