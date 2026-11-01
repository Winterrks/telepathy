/**
 * The tags telepathy wraps around what it puts in front of a model. A peer's message is
 * `<telepathy-peer-message>`; telepathy's own lines (setup, overlap, inbox notes) are `<telepathy-note>`.
 */
export const PEER_MESSAGE_TAG = 'telepathy-peer-message';
export const NOTE_TAG = 'telepathy-note';

/** What a `<telepathy-note>` is about. */
export type NoteKind = 'setup' | 'overlap' | 'inbox' | 'wake';

/** An attribute value: one line, no quotes or angle brackets to end the tag early. */
export function tagAttr(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * A message body cannot close its own wrapper or open a note that looks like telepathy's.
 * `<telepathy-…` and `</telepathy-…` become `<\telepathy-…`, the same escape the Claude socket uses.
 */
export const escapeTelepathyTags = (text: string) => text.replace(/<(\/?telepathy-)/gi, '<\\$1');

export function noteTag(kind: NoteKind, text: string): string {
  return `<${NOTE_TAG} kind="${kind}">${escapeTelepathyTags(text)}</${NOTE_TAG}>`;
}
