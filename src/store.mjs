import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname } from "node:path"

export async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temp=`${path}.opencode-tools-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temp, content, "utf8")
  await rename(temp, path)
}

export async function stageWrites(entries) {
  const staged=[]
  try {
    for(const entry of entries) {
      await mkdir(dirname(entry.path), { recursive: true })
      const temp=`${entry.path}.opencode-tools-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(temp, entry.content, "utf8")
      staged.push({temp,path:entry.path})
    }
  } catch(error) {
    await Promise.all(staged.map(item=>rm(item.temp,{force:true})))
    throw error
  }
  try { for(const item of staged) await rename(item.temp,item.path) }
  catch(error) { await Promise.all(staged.map(item=>rm(item.temp,{force:true}))); throw error }
}

/**
 * Commit a group of writes and removals as one recoverable filesystem change.
 * Files are first moved aside, so a failed promotion can restore every original
 * path, including a move source or a deletion target.
 */
export async function transactionalCommit({ writes, removals }) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const writePaths = new Set(writes.map(item => item.path))
  const paths = [...new Set([...writePaths, ...removals])]
  const staged = []
  const backups = []
  const promoted = new Set()

  try {
    for (const entry of writes) {
      await mkdir(dirname(entry.path), { recursive: true })
      const temp = `${entry.path}.opencode-tools-${stamp}.new`
      await writeFile(temp, entry.content, "utf8")
      staged.push({ path: entry.path, temp })
    }

    for (const path of paths) {
      if (!existsSync(path)) continue
      const backup = `${path}.opencode-tools-${stamp}.backup`
      await rename(path, backup)
      backups.push({ path, backup })
    }

    for (const item of staged) {
      await rename(item.temp, item.path)
      promoted.add(item.path)
    }

    await Promise.all(backups.map(item => rm(item.backup, { force: true })))
  } catch (error) {
    // Remove newly written files, then put every original file back in place.
    await Promise.all([...promoted].map(path => rm(path, { force: true }).catch(() => {})))
    for (const item of backups.reverse()) {
      try {
        await rm(item.path, { force: true })
        await rename(item.backup, item.path)
      } catch {
        // Preserve the original error; a remaining backup is recoverable evidence.
      }
    }
    throw error
  } finally {
    await Promise.all(staged.map(item => rm(item.temp, { force: true }).catch(() => {})))
  }
}
