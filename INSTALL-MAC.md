# Install and test LG webOS Control

## Requirements

- Stream Deck app 6.9 or later
- macOS 10.15 or later, or Windows 10 or later
- LG webOS TV on the same LAN or VLAN as the computer
- LG Connect Apps enabled on the TV

## Local install

1. Build the plugin package:

   ```bash
   npm install
   npm run pack
   ```

2. Double-click the generated package:

   ```text
   dist/com.leland.lg-webos-control.streamDeckPlugin
   ```

3. Drag **LG webOS Control** onto a Stream Deck key or Stream Deck + dial.
4. In the Property Inspector, click **Scan for TVs** or enter your TV IP manually.
5. Keep port set to `auto` unless you need to test a specific port.
6. Click **Pair / Re-pair** and approve the prompt on the TV.

## Troubleshooting

- If scan does not find the TV, enter the TV IP manually.
- If pairing does not prompt, confirm LG Connect Apps is enabled.
- If control fails after pairing, confirm the computer and TV are on the same LAN or VLAN.
- Common webOS websocket ports are `3001` and `3000`.

Pairing keys are stored locally by the plugin. Do not commit or share local pairing files.
