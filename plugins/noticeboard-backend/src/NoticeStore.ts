import crypto from 'node:crypto';
import {
  DatabaseService,
  resolvePackagePath,
} from '@backstage/backend-plugin-api';
import { Knex } from 'knex';

/** @public */
export interface Notice {
  id: string;
  title: string;
  body: string;
  /** Entity ref of the user who posted it */
  author: string;
  createdAt: string;
}

type NoticeRow = {
  id: string;
  title: string;
  body: string;
  author: string;
  created_at: Date | string | number;
};

const migrationsDir = resolvePackagePath(
  '@internal/backstage-plugin-noticeboard-backend',
  'migrations',
);

function toNotice(row: NoticeRow): Notice {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    author: row.author,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Notices in the plugin's own database (backstage_plugin_noticeboard). */
export class NoticeStore {
  static async create(database: DatabaseService): Promise<NoticeStore> {
    const client = await database.getClient();
    if (!database.migrations?.skip) {
      await client.migrate.latest({ directory: migrationsDir });
    }
    return new NoticeStore(client);
  }

  private constructor(private readonly db: Knex) {}

  async list(limit: number): Promise<Notice[]> {
    const rows = await this.db<NoticeRow>('notices')
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit);
    return rows.map(toNotice);
  }

  async add(input: {
    title: string;
    body: string;
    author: string;
  }): Promise<Notice> {
    const row: NoticeRow = {
      id: crypto.randomUUID(),
      ...input,
      created_at: new Date(),
    };
    await this.db<NoticeRow>('notices').insert(row);
    return toNotice(row);
  }
}
