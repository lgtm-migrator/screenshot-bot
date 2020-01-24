const puppeteer = require('puppeteer')
const format = require('date-fns/format')

const {upload} = require('./imgur')
const {fetchBox, fetchGames} = require('./nba')
const {allSettled} = require('./utils')
const reddit = require('./reddit')

const VIEWPORT = {width: 1440, height: 1080}
const URL = `file://${__dirname}/index.html`

const insertEnv = (page, name, value) => {
    page.evaluateOnNewDocument(`
        Object.defineProperty(window, '${name}', {
            get() {
                return ${JSON.stringify(value)}
            }
        })
    `)
}

const extractGames = (games) => {
    return games.map(game => {
        return Object.assign({}, game, {
            homeCity: game.home.city,
            homeName: game.home.team_code,
            homeNickname: game.home.nickname,
            visitorCity: game.visitor.city,
            visitorName: game.visitor.team_code,
            visitorNickname: game.visitor.nickname,
        })
    })
}

(async () => {
    // Initialization
    const browser = await puppeteer.launch()

    // fetch all the games for date
    const todayStr = format(new Date(), 'yyyyMMdd')
    console.log('fetching...', todayStr)
    let games = await fetchGames(todayStr)
    if (games == null || games.length === 0) {
        return;
    }

    // search sub reddit's recent post-game threads
    newPosts = await reddit.getNewPGTs()
    comments = await reddit.getComments()
    games = extractGames(games)
    const promises = games.map(async (game, i) => {
        console.log('trying to find', game.homeName, game.visitorName)
        const postGameThread = newPosts.find(post => {
            const title = post.title.toLowerCase()
            return (title.includes(game.homeName.toLowerCase()) ||
            title.includes(game.homeCity.toLowerCase()) ||
            title.includes(game.homeNickname.toLowerCase())) &&
            (title.includes(game.visitorName.toLowerCase()) ||
            title.includes(game.visitorCity.toLowerCase()) ||
            title.includes(game.visitorNickname.toLowerCase()))
        }
        )
        if (postGameThread == null) {
            console.log(`didn't find ${game.homeName}, ${game.visitorName}`)
            return
        }

        console.log('found thread', postGameThread.id)
        const hasCommented = comments.find(comment => comment.parent_id === `t3_${postGameThread.id}`) != null

        console.log('hasCommented', hasCommented)
        if (hasCommented) {
            return
        }
        console.log('fetching game box', game.id, 'thread', postGameThread.id)

        const data = await fetchBox(game.id)
        if (data == null) {
            return
        }

        // screenshot
        console.log('Taking a screenshot...', game.id)
        const page = await browser.newPage()
        await page.setViewport(VIEWPORT)
        insertEnv(page, 'box', data)
        await page.goto(URL)
        let element = await page.$('html')
        const light = await element.screenshot({
            // encoding: 'base64',
            path: __dirname + `/images/light-${data.vls.tn} vs ${data.hls.tn}.png`
        })

        // changing to dark mode
        await page.evaluate(() => {
            let body = document.querySelector('body');
            body.className += 'dark'
        });
        element = await page.$('html')
        const dark = await element.screenshot({
            // encoding: 'base64',
            path: __dirname + `/images/dark-${data.vls.tn} vs ${data.hls.tn}.png`
        })

        console.log('uploading to imgur...')
        let lightImgurLink;
        let darkImgurLink;
        const responses = await allSettled([
            upload(light, `${data.gdtutc} ${data.vls.tn} vs ${data.hls.tn}`),
            upload(dark, `${data.gdtutc} ${data.vls.tn} vs ${data.hls.tn}`)
        ])
        if (responses[0].status === 'fulfilled') {
            lightImgurLink = responses[0].value.data.link
            console.log(lightImgurLink)
        }
        if (responses[1].status === 'fulfilled') {
            darkImgurLink = responses[1].value.data.link
            console.log(darkImgurLink)
        }
        console.log('posting to reddit...')
        await reddit.postComment(postGameThread, lightImgurLink, darkImgurLink)
        console.log('finished posting to reddit...')
    })
    await allSettled(promises).finally(async () => await browser.close())
})()
