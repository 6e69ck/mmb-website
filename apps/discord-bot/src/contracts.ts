export type MessageTarget = { guildId: string; channelId: string; messageId: string };
export type AttachmentInput = { id: string; url: string; filename: string; contentType: string | null; size: number };
export type UploadMessageInput = MessageTarget & { authorId: string; createdAt: Date; caption: string; attachments: AttachmentInput[] };
export interface MediaStore {
  uploadMessage(input: UploadMessageInput): Promise<{ uploaded: number }>;
  deleteMessage(input: MessageTarget): Promise<void>;
  hasMessage(input: MessageTarget): Promise<boolean>;
}
