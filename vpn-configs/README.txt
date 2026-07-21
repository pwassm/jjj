Proton VPN — US WireGuard server configs go in THIS folder.

HOW TO FILL IT
1. Sign in at https://account.protonvpn.com  ->  Downloads
      (or Account -> WireGuard configuration)
2. Platform: Router / GNU'Linux (any full "0.0.0.0/0" config is fine).
3. For each US city/server you want in the rotation:
      - pick the server, generate the config, download the .conf
      - save it into this folder (M:\jjj\vpn-configs\)
4. Aim for ~8-20 different US servers for a good overnight spread.

NAMING
   Anything is fine — the rotator stages each pick under a fixed internal name,
   so long/odd filenames don't matter. A short descriptive name just makes the
   log easier to read, e.g.  US-NY-04.conf, US-CA-11.conf, US-TX-02.conf

SECURITY
   These .conf files contain your PRIVATE KEY. This folder is gitignored and is
   never committed. Don't share the files.

USAGE
   vpn-rotate.bat          switch to a different US server (run every ~18 downloads)
   vpn-rotate-setup.bat    run ONCE so switches are silent (no admin popup)
