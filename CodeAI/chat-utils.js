function mergeConsecutiveMessages(messages) {
  const merged = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      const previousParts = Array.isArray(previous.content)
        ? previous.content
        : [{ type: 'text', text: previous.content }];
      const nextParts = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: message.content }];
      previous.content = previousParts.concat(nextParts);
    } else {
      merged.push({ role: message.role, content: message.content });
    }
  }
  return merged;
}

module.exports = { mergeConsecutiveMessages };
