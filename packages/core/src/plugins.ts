import type { Context } from '@deepseek-ai/cordis'
import { SqliteLogStore } from './sqlite-store.ts'

/** Provider plugin for `ctx.logStore` backed by per-colony SQLite files. */
export const sqliteLogStore = {
  name: 'log-sqlite',
  apply(ctx: Context, config: { home: string }) {
    ctx.effect(() => {
      const store = new SqliteLogStore(config.home)
      const off = ctx.provide('logStore', store)
      return () => {
        off()
        store.close()
      }
    })
  },
}
