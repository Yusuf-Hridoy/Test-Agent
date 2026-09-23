# Example project folder

`saucedemo/` is what `magpie init` produces, kept in the repo as documentation of
the project-folder contract. It ships **without** `.env`, `.auth/` or `reports/` —
those are generated on your machine and are gitignored in a real project.

To use it:

```bash
cd test-projects/saucedemo
printf 'GOOGLE_GENERATIVE_AI_API_KEY=your-key\n' > .env
magpie login                     # standard_user / secret_sauce
magpie run --charter "Add the cheapest item to the cart and check the badge"
```

Note the `base_url`: it points at `/inventory.html`, a page that requires a
session, so Magpie can tell a live session from a dead one. Saucedemo's landing
page always shows the login form.
