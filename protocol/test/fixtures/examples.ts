// Valid example values shared by protocol tests.
export const chatID = "imsg##thread:+15550001111";
export const message = {
  id: "m-1",
  chatID,
  accountID: "imessage",
  senderID: "@alice:imessage",
  senderName: "Alice",
  timestamp: "2026-10-01T10:00:00.000Z",
  sortKey: "1000",
  type: "TEXT",
  text: "<script>alert(1)</script> ‮evil 👩‍👩‍👧",
  isSender: false,
  isUnread: true,
  attachments: [{ type: "img", url: "mxc://beeper.local/abc", mimeType: "image/png", fileName: "a.png", fileSize: 1234, width: 10, height: 10 }],
  reactions: [{ reactionKey: "❤️", participantID: "@bob:imessage", emoji: true }],
};
export const chat = {
  id: chatID,
  accountID: "imessage",
  network: "iMessage",
  title: "Alice",
  type: "single",
  unreadCount: 2,
  isPinned: false,
  isMuted: false,
  isArchived: false,
  lastActivity: "2026-10-01T10:00:00.000Z",
  preview: message,
};
export const account = { accountID: "imessage", network: "iMessage", status: "connected" };
