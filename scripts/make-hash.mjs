#!/usr/bin/env node
/**
 * Prints a PBKDF2 hash in the exact format the Workers runtime verifies,
 * plus a ready-to-run UPDATE statement.
 *
 *   npm run make-hash
 *
 * Node's webcrypto implements the same PBKDF2 primitive as crypto.subtle on
 * Workers, so hashes made here verify in the app.
 */
import { webcrypto } from 'node:crypto'
import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'

const ITERATIONS = 100000
const KEY_BITS = 256
const SALT_BYTES = 16

const b64 = (bytes) => Buffer.from(bytes).toString('base64')

async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    key,
    KEY_BITS
  )
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`
}

function ask(rl, question, { silent = false } = {}) {
  return new Promise((resolve) => {
    if (!silent) {
      rl.question(question, (answer) => resolve(answer.trim()))
      return
    }

    // Mask keystrokes so the password isn't left on screen.
    stdout.write(question)
    const wasMuted = rl.output.muted
    rl.output.muted = true
    rl.question('', (answer) => {
      rl.output.muted = wasMuted
      stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

async function main() {
  const rl = createInterface({
    input: stdin,
    output: new (await import('node:stream')).Writable({
      write(chunk, encoding, callback) {
        if (!rl.output.muted) stdout.write(chunk, encoding)
        callback()
      },
    }),
    terminal: true,
  })
  rl.output.muted = false

  const email = await ask(rl, 'Email (for the UPDATE statement): ')
  const password = await ask(rl, 'Password: ', { silent: true })
  const confirm = await ask(rl, 'Confirm password: ', { silent: true })
  rl.close()

  if (!password) {
    console.error('\nPassword cannot be empty.')
    process.exit(1)
  }
  if (password !== confirm) {
    console.error('\nPasswords do not match.')
    process.exit(1)
  }
  if (password.length < 8) {
    console.error('\nPassword must be at least 8 characters.')
    process.exit(1)
  }

  const hash = await hashPassword(password)

  console.log('\nPBKDF2 hash:')
  console.log(hash)
  console.log('\nRun this in the Supabase SQL editor:\n')
  console.log(
    `UPDATE wp_chat_users SET password_hash='${hash}' WHERE email='${email.replace(/'/g, "''")}';`
  )
  console.log('')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
