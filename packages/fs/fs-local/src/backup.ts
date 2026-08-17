/** Private, byte-preserving backup storage for local filesystem mutations. */

import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsBackupRef, FsVersion } from '@deepseek-ai/dsh-fs'

const COPY_BUFFER_BYTES = 64 * 1024

/** Test controls for deterministic names and mutation-race injection. */
export interface FsBackupInternals {
  /** Override the unpredictable leaf name in deterministic tests. */
  backupName?: (targetHash: string) => string
  /** Run after backup durability and before the provider rechecks the source. */
  afterBackup?: (backup: FsBackupRef) => void | Promise<void>
}

/** Resolved local backup storage settings. */
export interface LocalBackupConfig {
  backupEnabled: boolean
  backupRoot: string
  backupVersionsPerTarget: number
}

interface CreatedBackup {
  ref: FsBackupRef
  targetDirectory: string
}

function backupLeaf(targetHash: string, internals: FsBackupInternals): string {
  return internals.backupName?.(targetHash)
    ?? `${Date.now()}-${randomBytes(16).toString('hex')}.bak`
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

/**
 * Copy the opened source bytes into an exclusive, owner-only backup and sync it.
 * @param sourcePath - canonical source file path.
 * @param sourceVersion - version validated before copying.
 * @param config - private storage location and enablement.
 * @param signal - cancels before backup completion.
 * @param internals - deterministic test hooks.
 * @returns durable backup reference and its per-target directory.
 */
export async function createLocalBackup(
  sourcePath: string,
  sourceVersion: FsVersion,
  config: LocalBackupConfig,
  signal: AbortSignal | undefined,
  internals: FsBackupInternals,
): Promise<CreatedBackup> {
  if (!config.backupEnabled) {
    throw new FsError(`cannot back up "${sourcePath}": local backup storage is disabled`, 'FS_IO_ERROR')
  }
  const targetHash = createHash('sha256').update(sourcePath).digest('hex')
  const targetDirectory = join(config.backupRoot, targetHash)
  let backupPath = ''
  try {
    if (signal?.aborted) throw new FsError('backup aborted', 'FS_ABORTED')
    await privateDirectory(config.backupRoot)
    await privateDirectory(targetDirectory)
    backupPath = join(targetDirectory, backupLeaf(targetHash, internals))
    const source = await open(sourcePath, 'r')
    const destination = await open(backupPath, 'wx', 0o600)
    let bytes = 0
    try {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
      while (true) {
        if (signal?.aborted) throw new FsError('backup aborted', 'FS_ABORTED')
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        let written = 0
        while (written < bytesRead) {
          const result = await destination.write(buffer, written, bytesRead - written, null)
          written += result.bytesWritten
        }
        bytes += bytesRead
      }
      await chmod(backupPath, 0o600)
      await destination.sync()
      const ref: FsBackupRef = { path: backupPath, bytes, sourceVersion }
      await internals.afterBackup?.(ref)
      return { ref, targetDirectory }
    } finally {
      await Promise.allSettled([source.close(), destination.close()])
    }
  } catch (error: unknown) {
    if (backupPath.length > 0) await unlink(backupPath).catch(() => undefined)
    if (error instanceof FsError) throw error
    throw new FsError(`cannot back up "${sourcePath}": ${String(error)}`, 'FS_IO_ERROR', { cause: error })
  }
}

/**
 * Keep the newest configured number of backups after target publication.
 * @param targetDirectory - hashed directory for one canonical target.
 * @param keep - number of newest backups to retain.
 */
export async function pruneLocalBackups(targetDirectory: string, keep: number): Promise<void> {
  const names = (await readdir(targetDirectory)).filter(name => name.endsWith('.bak'))
  const entries = await Promise.all(names.map(async name => ({
    path: join(targetDirectory, name),
    modified: (await stat(join(targetDirectory, name))).mtimeMs,
    name,
  })))
  entries.sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name))
  await Promise.all(entries.slice(keep).map(entry => unlink(entry.path)))
}
