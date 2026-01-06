function normalizeNewlines(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function clampString(s, maxLen) {
    if (s.length <= maxLen)
        return s;
    return s.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…';
}
function splitIntoLines(text) {
    return normalizeNewlines(text).split('\n');
}
function rebuildFromLines(lines, startLine, endLineExclusive) {
    return lines.slice(startLine, endLineExclusive).join('\n').trim();
}
function isSeparatorLine(line) {
    const t = line.trim();
    if (!t)
        return false;
    if (/^[-=*#]{5,}$/.test(t))
        return true;
    if (/^(begin|end)\s+(chat|conversation|transcript)\b/i.test(t))
        return true;
    if (/^end\s+of\s+(chat|conversation)\b/i.test(t))
        return true;
    return false;
}
function parseLabeledParticipant(line) {
    const m = line.match(/^\s*(operator|agent|advisor|rep)\s*:\s*(.+?)\s*$/i);
    if (m)
        return { role: 'operator', name: m[2].trim() };
    const n = line.match(/^\s*(customer|client|caller|buyer)\s*:\s*(.+?)\s*$/i);
    if (n)
        return { role: 'customer', name: n[2].trim() };
    return null;
}
function findChatIdHeader(line) {
    // Examples we try to catch:
    // - Chat ID: 12345
    // - Conversation ID: abc
    // - Ticket ID: 999
    // - Chat #123
    const m = line.match(/^\s*(chat\s*(id|#)|conversation\s*id|ticket\s*(id|#))\s*[:#]?\s*(.+?)\s*$/i);
    if (!m)
        return null;
    const chatId = String(m[4] ?? '').trim();
    if (!chatId)
        return null;
    return { chatId };
}
function computeSegmentsFromStarts(lines, startLines) {
    const sorted = [...new Set(startLines)].sort((a, b) => a - b);
    const segments = [];
    for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i];
        const end = i + 1 < sorted.length ? sorted[i + 1] : lines.length;
        if (start < end)
            segments.push({ start, end });
    }
    return { segments };
}
function filterNonTrivialSegments(lines, segments) {
    // Avoid producing lots of tiny segments.
    const minChars = 120;
    return segments.filter((s) => rebuildFromLines(lines, s.start, s.end).length >= minChars);
}
export function splitTranscriptIntoChats(text) {
    const raw = String(text ?? '');
    const normalized = normalizeNewlines(raw).trim();
    if (!normalized) {
        return {
            strategy: 'SINGLE',
            warning: 'No text found to split.',
            chats: [{ index: 0, title: 'Chat 1', text: '' }]
        };
    }
    const lines = splitIntoLines(normalized);
    // F) Chat ID headers
    const chatIdStarts = [];
    for (let i = 0; i < lines.length; i++) {
        const id = findChatIdHeader(lines[i]);
        if (id)
            chatIdStarts.push({ lineIndex: i, chatId: id.chatId });
    }
    if (chatIdStarts.length >= 2) {
        const { segments } = computeSegmentsFromStarts(lines, chatIdStarts.map((x) => x.lineIndex));
        const usable = filterNonTrivialSegments(lines, segments);
        if (usable.length >= 2) {
            const chats = usable.map((seg, idx) => {
                const header = chatIdStarts.find((x) => x.lineIndex === seg.start);
                const chatId = header?.chatId;
                return {
                    index: idx,
                    title: chatId ? `Chat ${clampString(chatId, 48)}` : `Chat ${idx + 1}`,
                    ...(chatId ? { chatId } : {}),
                    text: rebuildFromLines(lines, seg.start, seg.end)
                };
            });
            return { strategy: 'CHAT_ID', chats };
        }
    }
    // B) Explicit separators
    const sepStarts = [];
    for (let i = 0; i < lines.length; i++) {
        if (!isSeparatorLine(lines[i]))
            continue;
        // Next non-empty line is the start of the next segment
        let j = i + 1;
        while (j < lines.length && !String(lines[j] ?? '').trim())
            j++;
        if (j < lines.length)
            sepStarts.push(j);
    }
    // We treat the beginning of the file as a start as well.
    if (sepStarts.length >= 1) {
        const starts = [0, ...sepStarts];
        const { segments } = computeSegmentsFromStarts(lines, starts);
        const usable = filterNonTrivialSegments(lines, segments);
        if (usable.length >= 2) {
            const chats = usable.map((seg, idx) => ({
                index: idx,
                title: `Chat ${idx + 1}`,
                text: rebuildFromLines(lines, seg.start, seg.end)
            }));
            return { strategy: 'SEPARATORS', chats };
        }
    }
    // D) Operator+Customer participant blocks (common exports: a small metadata block per chat)
    const participantStarts = [];
    for (let i = 0; i < lines.length; i++) {
        const first = parseLabeledParticipant(lines[i]);
        if (!first)
            continue;
        const participants = {};
        participants[first.role] = first.name;
        // Look for the other participant in the next few lines (metadata blocks tend to be compact).
        for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
            const next = parseLabeledParticipant(lines[j]);
            if (!next)
                continue;
            participants[next.role] = next.name;
            break;
        }
        const hasBoth = Boolean(participants.operator) && Boolean(participants.customer);
        if (hasBoth)
            participantStarts.push({ lineIndex: i, participants });
    }
    if (participantStarts.length >= 2) {
        const { segments } = computeSegmentsFromStarts(lines, participantStarts.map((x) => x.lineIndex));
        const usable = filterNonTrivialSegments(lines, segments);
        if (usable.length >= 2) {
            const chats = usable.map((seg, idx) => {
                const start = participantStarts.find((x) => x.lineIndex === seg.start);
                const participants = start?.participants;
                const title = participants?.operator && participants.customer ? `${clampString(participants.operator, 28)} ↔ ${clampString(participants.customer, 28)}` : `Chat ${idx + 1}`;
                return {
                    index: idx,
                    title,
                    ...(participants ? { participants } : {}),
                    text: rebuildFromLines(lines, seg.start, seg.end)
                };
            });
            return { strategy: 'SPEAKER_BLOCKS', chats };
        }
    }
    // A) Fallback: treat as single chat
    return {
        strategy: 'SINGLE',
        warning: 'Could not reliably detect multiple chats in this file. The entire upload was treated as a single chat. If this is wrong, export chats with a Chat ID header or separators between chats.',
        chats: [{ index: 0, title: 'Chat 1', text: normalized }]
    };
}
