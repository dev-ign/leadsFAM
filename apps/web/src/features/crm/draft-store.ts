export interface Draft<T> {
  value: T;
  dirty: boolean;
  phase: 'editing' | 'saving' | 'uncertain' | 'done';
  requestKey: string;
  submitted: T | null;
  resultId: string | null;
  error: string;
}
export interface DraftToken {
  user: string;
  org: string;
  epoch: number;
}
// This store has one active, verified tenant scope. Nothing here is persisted.
export class DraftStore {
  private user: string | null = null;
  private org: string | null = null;
  private memberships = new Set<string>();
  private roles = new Map<string, string>();
  private frozen = true;
  private epoch = 0;
  private revision = 0;
  private records = new Map<string, Draft<unknown>>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  establish(user: string, organizations: { id: string; role: string }[]) {
    if (this.user !== user) {
      this.records.clear();
      this.org = null;
      this.epoch++;
    }
    this.user = user;
    const previousRole = this.org ? this.roles.get(this.org) : undefined;
    this.roles = new Map(organizations.map((v) => [v.id, v.role]));
    this.memberships = new Set(organizations.map((v) => v.id));
    if (this.org && previousRole !== this.roles.get(this.org)) {
      this.records.clear();
      this.epoch++;
    }
    if (this.org && !this.memberships.has(this.org)) {
      this.records.clear();
      this.org = null;
      this.epoch++;
    }
    this.frozen = false;
    this.publish();
  }
  suspend() {
    if (!this.frozen) {
      this.frozen = true;
      this.publish();
    }
  }
  clear() {
    this.records.clear();
    this.user = null;
    this.org = null;
    this.frozen = true;
    this.epoch++;
    this.publish();
  }
  activate(org: string) {
    if (this.frozen || !this.user || !this.memberships.has(org) || this.org === org) return;
    this.records.clear();
    this.org = org;
    this.epoch++;
    this.publish();
  }
  revoke(org: string) {
    if (this.org === org) {
      this.records.clear();
      this.org = null;
      this.epoch++;
      this.publish();
    }
  }
  token(org: string): DraftToken | null {
    return !this.frozen && this.user && this.org === org && this.memberships.has(org)
      ? { user: this.user, org, epoch: this.epoch }
      : null;
  }
  visible(token: DraftToken | null) {
    return token !== null && !this.frozen && this.valid(token);
  }
  private valid(token: DraftToken) {
    return (
      this.user === token.user &&
      this.org === token.org &&
      this.epoch === token.epoch &&
      this.memberships.has(token.org)
    );
  }
  private key(token: DraftToken, form: string) {
    return JSON.stringify([token.user, token.org, form]);
  }
  read<T>(org: string, form: string): Draft<T> | undefined {
    const token = this.token(org);
    return token ? (this.records.get(this.key(token, form)) as Draft<T> | undefined) : undefined;
  }
  ensure<T>(org: string, form: string, seed: Draft<T>) {
    const token = this.token(org);
    if (token && !this.records.has(this.key(token, form))) {
      this.records.set(this.key(token, form), seed);
      this.publish();
    }
  }
  write<T>(
    token: DraftToken | null,
    form: string,
    seed: Draft<T>,
    update: (value: Draft<T>) => Draft<T>,
  ) {
    if (!token || !this.valid(token)) return;
    const key = this.key(token, form);
    this.records.set(key, update((this.records.get(key) as Draft<T> | undefined) ?? seed));
    this.publish();
  }
  remove(token: DraftToken | null, form: string) {
    if (token && this.valid(token)) {
      this.records.delete(this.key(token, form));
      this.publish();
    }
  }
  discardActive() {
    this.records.clear();
    this.epoch++;
    this.publish();
  }
  hasDirty() {
    return [...this.records.values()].some((v) => v.dirty);
  }
}
