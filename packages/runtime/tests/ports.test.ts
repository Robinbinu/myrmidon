import { expect, test } from 'bun:test'
import { listeningPorts, type PortProbe, windowsNetstatPorts } from '../src/ports.ts'

// The listening ports each OS reports, from output captured there.

const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:10DE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0
   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41240 1 0000000000000000 100 0 0 10 0
   2: 0100007F:10DE 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 41300 1 0000000000000000 20 4 30 10 -1
`
const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52000 1 0000000000000000 100 0 0 10 0
`
const MAC_NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.4318         *.*                    LISTEN
tcp4       0      0  192.168.1.20.52144     140.82.112.25.443      ESTABLISHED
tcp46      0      0  *.5173                 *.*                    LISTEN
`
const MAC_LSOF = `p812
f23
n127.0.0.1:4318
p990
f30
n[::1]:3000
`
/** `netstat -an` on an English Windows 11. */
const WINDOWS_NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING
  TCP    127.0.0.1:4318         0.0.0.0:0              LISTENING
  TCP    127.0.0.1:4318         127.0.0.1:52101        ESTABLISHED
  TCP    192.168.1.20:52144     140.82.112.25:443      ESTABLISHED
  TCP    192.168.1.20:52150     20.42.65.85:443        TIME_WAIT
  TCP    [::]:135               [::]:0                 LISTENING
  TCP    [::1]:5173             [::]:0                 LISTENING
  UDP    0.0.0.0:5353           *:*
  UDP    [::]:5353              *:*
`
/** The same on a German Windows: headings and states are translated. */
const WINDOWS_NETSTAT_DE = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status
  TCP    127.0.0.1:4318         0.0.0.0:0              ABHÖREN
  TCP    192.168.1.20:52144     140.82.112.25:443      HERGESTELLT
  TCP    [::1]:5173             [::]:0                 ABHÖREN
`

function probe(platform: NodeJS.Platform, outputs: Record<string, string | undefined>): PortProbe {
  return {
    platform,
    readFile: (path) => {
      const text = outputs[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    run: (tool) => outputs[tool],
  }
}

const sorted = (ports: Set<number> | undefined) => (ports ? [...ports].sort((a, b) => a - b) : ports)

test('Linux reads LISTEN sockets from /proc/net/tcp and tcp6', () => {
  const ports = listeningPorts(
    probe('linux', { '/proc/net/tcp': PROC_NET_TCP, '/proc/net/tcp6': PROC_NET_TCP6 }),
  )
  expect(sorted(ports)).toEqual([4318, 5173, 8080])
  // A table it cannot read leaves the answer unknown.
  expect(listeningPorts(probe('linux', { '/proc/net/tcp': PROC_NET_TCP }))).toBeUndefined()
})

test('macOS joins netstat and lsof, and is unknown only when both fail', () => {
  expect(sorted(listeningPorts(probe('darwin', { netstat: MAC_NETSTAT, lsof: MAC_LSOF })))).toEqual([
    3000, 4318, 5173,
  ])
  expect(sorted(listeningPorts(probe('darwin', { lsof: MAC_LSOF })))).toEqual([3000, 4318])
  expect(listeningPorts(probe('darwin', {}))).toBeUndefined()
})

test('Windows reads netstat -an, IPv4 and IPv6, whatever language its states are in', () => {
  expect(windowsNetstatPorts(WINDOWS_NETSTAT)).toEqual([135, 445, 4318, 135, 5173])
  expect(windowsNetstatPorts(WINDOWS_NETSTAT_DE)).toEqual([4318, 5173])
  expect(sorted(listeningPorts(probe('win32', { netstat: WINDOWS_NETSTAT })))).toEqual([135, 445, 4318, 5173])
  expect(listeningPorts(probe('win32', {}))).toBeUndefined()
})

test('on this machine, a port just opened is among them', () => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  try {
    expect(listeningPorts()?.has(server.port)).toBe(true)
  } finally {
    server.stop(true)
  }
})
