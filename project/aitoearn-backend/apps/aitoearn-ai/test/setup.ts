import { fileURLToPath } from 'node:url'
import 'reflect-metadata'

// Importing the app configuration requires the same CLI argument as the Nest entry point.
process.argv.push('--config', fileURLToPath(new URL('../config/config.yaml', import.meta.url)))
