// File references stay in this browser only. They are never part of API payloads.
export function pendingImagePreviews(files) {
  return files.flatMap((file, index) => file.type.startsWith('image/') ? [{
    id: `local-image-${index}`, name: file.name, type: file.type, size: file.size,
    localFile: file, encrypted: false,
  }] : []);
}

export function withLocalImagePreviews(message, files) {
  if (!message?.attachments?.length) return message;
  return {
    ...message,
    attachments: message.attachments.map((attachment, index) => {
      const file = files[index];
      return file?.type.startsWith('image/') && attachment.type?.startsWith('image/')
        ? { ...attachment, localFile: file } : attachment;
    }),
  };
}

export function retainLocalImagePreviews(message, previous) {
  if (!message?.attachments?.length || !previous?.attachments?.length) return message;
  const files = new Map(previous.attachments.filter(item => item.localFile).map(item => [item.id, item.localFile]));
  return { ...message, attachments: message.attachments.map(item => !item.localFile && files.has(item.id)
    ? { ...item, localFile: files.get(item.id) } : item) };
}
