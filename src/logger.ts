import * as fs from 'fs'
import * as path from 'path'

const LOG_FILE = path.join(process.cwd(), 'app.log')

function getTimestamp(): string {
  return new Date().toISOString()
}

export function log(message: string): void {
  const logMessage = `[${getTimestamp()}] ${message}\n`
  console.log(message)
  fs.appendFileSync(LOG_FILE, logMessage)
}

export function logError(message: string, error?: any): void {
  const errorMessage = error ? `${message}: ${error}` : message
  const logMessage = `[${getTimestamp()}] ERROR: ${errorMessage}\n`
  console.error(errorMessage)
  fs.appendFileSync(LOG_FILE, logMessage)
}
