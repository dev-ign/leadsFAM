import pg from 'pg';

// Restricted LOGIN roles can only invoke named, bounded private entry points.
// Neither runtime accepts a tenant, actor, SQL string or arbitrary RPC name.
export class AutomationDatabase {
  private readonly pool;
  constructor(
    connectionString: string,
    private readonly mode: 'ingress' | 'worker',
  ) {
    this.pool = new pg.Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
  }
  async start() {
    const result = await this.pool.query(
      "select current_user name,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,pg_has_role(current_user,'leadsfam_automation','MEMBER') execution,pg_has_role(current_user,'authenticated','MEMBER') authenticated,exists(select 1 from pg_auth_members where member=current_user::regrole) memberships,has_table_privilege(current_user,'public.contacts','SELECT') tenant from pg_roles where rolname=current_user",
    );
    const role = result.rows[0] as Record<string, unknown>;
    if (
      role.name !== `leadsfam_${this.mode}` ||
      role.rolsuper ||
      role.rolbypassrls ||
      role.rolcreaterole ||
      role.rolcreatedb ||
      role.execution ||
      role.authenticated ||
      role.memberships ||
      role.tenant
    )
      throw new Error('Unsafe automation runtime database role');
  }
  async ingest(hash: string, input: unknown, correlationId: string): Promise<unknown> {
    if (this.mode !== 'ingress') throw new Error('Invalid runtime capability');
    const result = (
      await this.pool.query('select private.ingest_lead($1,$2::jsonb,$3::uuid) result', [
        hash,
        JSON.stringify(input),
        correlationId,
      ])
    ).rows[0]?.result as unknown;
    if (result && typeof result === 'object' && 'state' in result && result.state === 'rejected') {
      const code =
        'code' in result && typeof result.code === 'string' ? result.code : 'ingestion_unavailable';
      throw new Error(code);
    }
    return result;
  }
  async claim(): Promise<unknown> {
    if (this.mode !== 'worker') throw new Error('Invalid runtime capability');
    return (await this.pool.query('select private.automation_claim() result')).rows[0]
      ?.result as unknown;
  }
  async execute(id: string, token: string, generation: number): Promise<unknown> {
    if (this.mode !== 'worker') throw new Error('Invalid runtime capability');
    return (
      await this.pool.query(
        'select private.automation_execute($1::uuid,$2::uuid,$3::integer) result',
        [id, token, generation],
      )
    ).rows[0]?.result as unknown;
  }
  async claimCommunication(): Promise<unknown> {
    if (this.mode !== 'worker') throw new Error('Invalid runtime capability');
    return (await this.pool.query('select private.communication_claim() result')).rows[0]
      ?.result as unknown;
  }
  async prepareCommunication(id: string, token: string, generation: number): Promise<unknown> {
    if (this.mode !== 'worker') throw new Error('Invalid runtime capability');
    return (
      await this.pool.query(
        'select private.communication_prepare($1::uuid,$2::uuid,$3::integer) result',
        [id, token, generation],
      )
    ).rows[0]?.result as unknown;
  }
  async finishCommunication(
    id: string,
    token: string,
    generation: number,
    result: unknown,
  ): Promise<void> {
    if (this.mode !== 'worker') throw new Error('Invalid runtime capability');
    await this.pool.query(
      'select private.communication_finish($1::uuid,$2::uuid,$3::integer,$4::jsonb)',
      [id, token, generation, JSON.stringify(result)],
    );
  }
  async communicationEvent(event: unknown): Promise<unknown> {
    if (this.mode !== 'ingress') throw new Error('Invalid runtime capability');
    return (
      await this.pool.query('select private.communication_provider_event($1::jsonb) result', [
        JSON.stringify(event),
      ])
    ).rows[0]?.result as unknown;
  }
  async close() {
    await this.pool.end();
  }
}
