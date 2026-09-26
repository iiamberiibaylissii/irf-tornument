# IRF Racing Tournament

A GitHub Pages tournament board with a separate judges page. The starting roster is loaded from the [IRF race team sheet](https://docs.google.com/spreadsheets/d/1mRMH_qbFPpdQ7RjJJYKD-PuHKDZqrwQWfihtoj4Nt_o/edit?gid=0#gid=0). `Department` is the team name. `Main Driver` races by default, and `Backup #1–3` can be chosen as substitutes for an individual race.

## Tournament rules

- **23 drivers** start in three groups of **8, 8 and 7**. Each group is below the 20-player server limit. Ten departments without a Main Driver are listed as pending and are outside the grid.
- Each group runs **five timed qualifying races**. An official time is entered for every driver in each race using `m:ss.mmm` or `seconds.mmm`.
- Judges enter the time recorded by the game. Each press of **+0.1s** or **+0.2s** adds that penalty to the driver's time; **Undo last** removes the most recent press. Standings use the adjusted times.
- Judges can shuffle the starting grid while groups have not started. A group is locked when a judge marks it started or posts its first race result; later draws only change remaining unstarted groups.
- The five times are **added**. The **two lowest total times from each group** qualify for the six-driver finale.
- The finale is currently set to **one timed race**. The lowest finale time wins. The engine also supports a five-race finale if the organizer decides to use one.
- An exact tie at the qualifying cutoff or for the championship is flagged. The site does not choose an unapproved tiebreaker.

Judges may submit a corrected time. If a correction changes the six finalists, existing finale results are cleared. GitHub commit history keeps earlier versions.

## Website

- Public board: https://iiamberiibaylissii.github.io/irf-tornument/
- Separate judges page: https://iiamberiibaylissii.github.io/irf-tornument/judges.html
- Source repository: https://github.com/iiamberiibaylissii/irf-tornument

GitHub Pages is configured to publish from GitHub Actions. The included workflows deploy the site and process judges' results. Keep Issues enabled so judges can submit times.

## Approve judges

Edit `config/judges.json` and put each judge’s **GitHub username** in the `usernames` list, for example:

```json
{ "usernames": ["judge-one", "judge-two"] }
```

The repository owner can also submit. Judges need a GitHub account, but they **do not need a personal access token or repository write access**. The approved usernames are checked by GitHub Actions when each result is submitted. Keep the judges page link within the officiating team; the link itself is not a password. Results are accepted only from approved GitHub accounts.

## Judge workflow

1. Open the separate judges link. If needed, use **Shuffle** and confirm the proposed draw on GitHub. Mark each group **started** when racing begins and confirm that on GitHub; its drivers will then stay in place.
2. Select a group and race. Enter each driver's game time, choose any backup, and press **+0.1s** or **+0.2s** for each infraction. Use **Undo last** to correct a press.
3. Click **Review & submit on GitHub**. The next page is prefilled. Sign in to GitHub if asked, check the times, and click **Create**.
4. GitHub posts a confirmation on that submission and publishes the updated public board shortly afterward. Refresh the judges page before preparing another race so it uses the latest results.

The submission is a GitHub issue containing race times. It is public like the tournament board. A workflow validates the submitting username and the race, saves `site/data/tournament.json`, comments with the outcome, and closes successful submissions. If the same race changed since the judge opened the page, the workflow refuses to overwrite it and asks the judge to refresh.

## Test locally

Run `npm test` from this folder. To preview, serve the `site` directory with a local static server. The final GitHub submission link only works once the project is published in a repository.
