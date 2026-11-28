# Media location and panorama

## What it does
Reads the place a photo was taken from the file and compares it with the site. Flags a photo that is far from its site. Marks panorama and drone files and opens them in a viewer.

## Turn it on and tune it
Settings > Documents > Media > Location. Set the far distance (metres), the panorama minimum ratio and width, and the drone makers. Every change asks for a reason and is written to the audit log.

## Older files
New uploads are read at upload time. For files uploaded before, press "Scan older images". Each press reads one batch; the screen shows how many are still waiting. Press again until it reaches zero. It is safe to repeat.

## Files without a point
A photo without GPS shows no distance. Use the filter "No point" to list them. "Flag files without a point" in Settings treats them as far.

## Reset and backup
The table `media_geo` is derived from the files. The data reset plan clears it with its files; a scan rebuilds it.
