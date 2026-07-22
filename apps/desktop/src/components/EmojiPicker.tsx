const emojiOptions = [
  ['😊', '微笑'], ['😂', '笑哭'], ['😍', '喜爱'], ['😎', '酷'],
  ['😭', '大哭'], ['😡', '生气'], ['🤔', '思考'], ['😱', '惊讶'],
  ['👍', '赞'], ['👏', '鼓掌'], ['❤️', '爱心'], ['🎉', '庆祝'],
] as const;

type EmojiPickerProps = Readonly<{
  onSelect(emoji: string): void;
}>;

export function EmojiPicker({ onSelect }: EmojiPickerProps) {
  return (
    <div className="emoji-picker" role="group" aria-label="表情选择">
      {emojiOptions.map(([emoji, label]) => (
        <button
          type="button"
          key={emoji}
          aria-label={label}
          title={label}
          onClick={() => onSelect(emoji)}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
