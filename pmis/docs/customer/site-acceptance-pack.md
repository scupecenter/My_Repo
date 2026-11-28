# Site acceptance pack

On the Documents tab of a site, "Acceptance pack (zip)" prepares one archive for the client.

- It holds the approved, current files of the acceptance documents (PAC, FAC and HOTO) of that site, one folder per document type.
- `INDEX.txt` lists the site, the date and the number of files per document type, in English and Arabic. `manifest.csv` lists every file with its checksum.
- Files still waiting for the virus scan are left out and listed in the manifest, as in every zip.
- It runs as the usual background job and downloads when ready. You only get files from your own regions.
- It follows the export lock: when exports are disabled, the pack cannot be made. No public link is created.
- A site with no approved acceptance document gets the message that no file matches.
