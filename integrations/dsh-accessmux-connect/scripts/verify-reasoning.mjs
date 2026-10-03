import { writeFile } from 'node:fs/promises'
import { verifyRegistered } from './reasoning-fixture.mjs'
const evidence = await verifyRegistered()
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({ node: evidence.node, snapshots: evidence.snapshots.length, requests: evidence.requests.length, updates: evidence.updates, pass: true }))
