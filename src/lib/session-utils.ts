import type { Session } from '@/api/sessions';

export function sessionLabel(session: Pick<Session, 'name' | 'user_name' | 'chat_name' | 'id'>) {
  return session.name || session.user_name || session.chat_name || `Session ${session.id.slice(0, 8)}`;
}

export function sessionMatchesSearch(session: Session, query: string) {
  if (!query) {
    return true;
  }
  const haystack = [
    sessionLabel(session),
    session.session_key,
    session.last_message?.content || '',
    session.user_name || '',
    session.chat_name || '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export function sortSessionsByLiveAndUpdated(items: Session[]) {
  return [...items].sort((a, b) => {
    if (a.live !== b.live) {
      return a.live ? -1 : 1;
    }
    return (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '');
  });
}

export function timeAgo(iso: string, justNowLabel = 'just now') {
  if (!iso) {
    return '';
  }
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) {
    return justNowLabel;
  }
  if (mins < 60) {
    return `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
