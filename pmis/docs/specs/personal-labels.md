# Personal coloured labels

A person makes their own coloured labels and puts them on sites and register records.

- Personal: a label and its links belong to the person who made them. Nobody else sees or uses them (another person's label id answers 404), so no access changes.
- Colours come from a fixed palette of nine; a colour always comes with the name, never alone. At most 30 active labels, 1 to 40 characters, unique per person.
- Hidden, never deleted: hiding a label removes it from every list and keeps the rows. Taking a label off a record removes only that link.
- Where: the Labels button on the site page and on the register record form (tick, make a new one, hide). Chips show the labels on the record.
- Filter and group: "My labels" (`/my-labels`) lists each label with its records, grouped by label, or filtered to one label. Sites open the site; register records open the register at that record.
- Data: migration 0740 (`user_labels`, `user_label_links`), kept on a data reset like saved views. Contract 0.15.620.
