\- Add a floating version button in the lower-right corner showing `v{N}`

\- Tell me when the thread is getting long and I should start a new one. Also 

&#x20; suggest whether the model used (Opus, Sonnet) best for the job. 


\## Project: SeeAndLearn

Core data file: `ml.json` (masterlinks.json) — do NOT restructure or rename this.



\### Screens \& their purpose

| Screen | Code | Audience | Notes |

|--------|------|----------|-------|

| Table | T | Dev | Main view of ml.json rows |

| Annotate/Tag | A | Dev | Adds tags to rows; different from other screens, always 

shown to R side of content screen|

| Edit Video | E | Dev | Selects video segments |

| View Video | V | Both | View-only, no editing |

| Picture | P | Both | Shows image from link |

| Dictionary | D | Dev | Manages tags.json |

| Grid | G | Both | Gd (dev) and Gu (user) differ |

| Config | C | Both | Saves grid config to c.json; Cd/Cu differ |

| Text | Xe | Dev | Xe = editing, raw html  |

| Text | Xs | Both | Xs = slide, rendered html |

| Quiz | Q | Both | |

| Help | H | Both | Hd (dev) and Hu (user) differ |



\### Key field names — never rename these

\- `link` — video/image URL in ml.json rows

\- `ftext` — HTML script or quiz content in ml.json rows



\### Developer scrolling mode

E hotkey lets developer scroll rows for editing/tagging across Xu, E, I screens.



