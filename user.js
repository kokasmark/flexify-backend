const bcrypt = require("bcrypt")
const crypto = require('crypto')
const moment = require('moment')


class User{
    constructor(req, res, db, log){
        this.req = req
        this.res = res
        this.db = db
        this.log = log

        this.loggedIn = this.getUserId()
        this.admin = this.getAdmin()
        this.alreadyResponded = false
    }

    async getUserId(){
        const token = this.req.get("X-Token")
        if (!token) return false
        let result = await this.db.query('SELECT user_id FROM login WHERE token = ?', [token])
        if (!result[0]) return false
        this.id = result[0].user_id
        return true
    }
    async isLoggedIn(){
        if (await this.loggedIn) return true

        this.respond(401, {reason: 'Invalid token'})
        return false
    }

    async getAdmin(){
        if (!await this.loggedIn) return false
        
        let result = await this.db.query('SELECT is_admin FROM user WHERE id = ?', [this.id], true)
        return !!result.is_admin
    }
    async isAdmin(){
        if (!await this.isLoggedIn() || !await this.admin){
            this.respond(401, {reason: 'Unauthorized'})
            return false
        } 

        await this.db.initStructure()
        return true
    }

    validateFields(fieldList){
        const regex = {
            token: /^[a-f0-9]+$/,
            reset_token: /^[a-f0-9]+$/,

            email: /^[\w-.]+@([\w-]+\.)+[\w-]{2,4}$/,
            username: /^[a-zA-Z0-9._-]{5,}$/,
            login: /^(([\w-.]+@([\w-]+\.)+[\w-]{2,4})|([a-zA-Z0-9._-]{5,}))$/,
            //TODO: uncomment when done testing 
            //password: /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[a-zA-Z]).{8,}$/,
            
            date: /^[0-9]{4}(-[0-9]{1,2}){1,2}$/,
            timespan: /^[0-9]+$/,

            id: /^[0-9]+$/,
            location: /^(web)|(mobile)$/,
        }

        let reqFields = this.req.body
        let toReturn = {}
        for (const field of fieldList){
            if (!reqFields.hasOwnProperty(field)) {
                this.log(0, `Missing POST field: ${field}`)
                return false
            }
            if (regex.hasOwnProperty(field) && !regex[field].test(reqFields[field])) {
                this.log(0, `Regex for field [${field}] failed with: ${reqFields[field]}`)
                return false
            }
            toReturn[field] = reqFields[field]
        }
        return toReturn
    }

    async workoutDates(){
        const post = this.validateFields(["date"])
        if (!post) return false
        if (!(await this.isLoggedIn())) return false

        let date = post.date.split("-")
        if (date[1].length == 1) date[1] = "0" + date[1]
        let paddedDate = `${date[0]}-${date[1]}`
        let sql = 'SELECT DATE_FORMAT(calendar.date, "%Y-%m-%d") as date FROM calendar_workout INNER JOIN calendar ON calendar_workout.calendar_id = calendar.id WHERE DATE_FORMAT( calendar.date, "%Y-%m") = ? AND calendar.user_id = ?'
        let result = await this.db.query(sql, [paddedDate, this.id])
        
        return result.map(x => x.date)
    }

    async userWorkoutsTimespan(){
        const post = this.validateFields(["timespan"])
        if (!post) return false
        if (!(await this.isLoggedIn())) return false

        let sql = 'SELECT workout.json FROM calendar_workout INNER JOIN calendar ON calendar_workout.calendar_id = calendar.id INNER JOIN workout ON calendar_workout.workout_id = workout.id WHERE calendar.user_id = ? AND calendar.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND workout.is_template = 0 AND workout.is_finished=1'
        let result = await this.db.query(sql, [this.id, post.timespan])
        let workouts = result.map(row => {
            row.json = JSON.parse(row.json)
            return row
        })

        return workouts
    }

    async userDetails(){
        if (!(await this.isLoggedIn())) return false
        
        let sql = 'SELECT username, email, is_admin FROM user WHERE id=?'
        
        return this.db.query(sql, [this.id], true)
    }

    async userWorkoutsMonth(){
        const post = this.validateFields(["date"])
        if (!post) return false
        if (!(await this.isLoggedIn())) return false

        let sql = 'SELECT workout.id, workout.name, workout.json, workout.time, workout.is_finished AS isFinished FROM calendar_workout INNER JOIN workout ON calendar_workout.workout_id = workout.id INNER JOIN calendar ON calendar_workout.calendar_id = calendar.id WHERE calendar.date = ? AND workout.user_id = ? AND workout.is_template = 0'
        let result = await this.db.query(sql, [post.date, this.id])
        return result
    }

    async userTemplates(){
        if (!(await this.isLoggedIn())) return false

        let sql = 'SELECT workout.name, workout.json, workout.id FROM workout WHERE workout.is_template = 1 AND workout.user_id = ?'
        let result = await this.db.query(sql, [this.id])
        const templates = result.map(template => {
            return {id: template.id, name:template.name, json:JSON.parse(template.json)}
        })
        

        return templates
    }

    async login(){
        const post = this.validateFields(["user", "password", "location"])
        if (!post) return false

        let sql = 'SELECT id, password FROM user WHERE username = ? OR email = ?'
        let result = await this.db.query(sql, [post.user, post.user], true)
        if (!result) return 0

        const id = result.id
        const passwordHash = result.password
        if (!(await this.compareHash(post.password, passwordHash))) return 0

        const token = await this.generateToken(32)
        sql = 'DELETE FROM login WHERE location=? AND user_id=?'
        this.db.query(sql, [post.location, id], true)
        sql = 'INSERT INTO login (location, user_id, token) VALUES (?, ?, ?)'
        this.db.query(sql, [post.location, id, token], true)

        return this.updateToken(id, post.location)
    }

    async register(){
        const post = this.validateFields(["username", "email", "password", "location"])
        if (!post) return false

        let sql = 'SELECT id FROM user WHERE username = ? OR email = ?'
        let result = await this.db.query(sql, [post.username, post.email])
        if (result.length) return 0

        const passwordHash = await this.generateHash(post.password)
        sql = 'INSERT INTO user (username, email, password) VALUES (?, ?, ?)'
        result = await this.db.query(sql, [post.username, post.email, passwordHash])
        const id = result.insertId

        return this.updateToken(id, post.location)
    }

    async updateToken(id, location){
        const token = await this.generateToken(32)

        let sql = 'DELETE FROM login WHERE location=? AND user_id=?'
        this.db.query(sql, [location, id], true)
        sql = 'INSERT INTO login (location, user_id, token) VALUES (?, ?, ?)'
        this.db.query(sql, [location, id, token], true)

        return token
    }

    async getDiet(date){
        let sql = "SELECT id, diet FROM calendar WHERE user_id=? AND date=?"
        let result = await this.db.query(sql, [this.id, date], true)

        if (result === undefined) result = {id: -1, diet: ''}
        if (result.diet === ''){
            let empty = []
            result.diet = {breakfast: empty, lunch: empty, dinner: empty, snacks: empty}
        }
        else result.diet = JSON.parse(result.diet)

        return result
    }

    async diet(){
        const post = this.validateFields(["date"])
        if (!post) return false
        if (!await this.isLoggedIn()) return false

        const result = await this.getDiet(post.date)
        return result.diet
    }

    async dietAdd(){
        const post = this.validateFields(["json"])
        if (!post) return false
        if (!await this.isLoggedIn()) return false

        let result = await this.getDiet(moment().format('YYYY-MM-DD'))
        if (result.id === -1){
            let sql ="INSERT INTO calendar (user_id, date, diet) VALUES (?, CURDATE(), ?)"
            this.db.query(sql, [this.id, JSON.stringify(post.json)])
            return
        }

        let sql = `UPDATE calendar SET diet=? WHERE id=?`
        this.db.query(sql, [JSON.stringify(post.json), result.id])

        return true
    }

    async dietAll(){
        if (!await this.isLoggedIn()) return false

        let sql = "SELECT date, carbs, fat, protein FROM calendar WHERE user_id=?"
        return this.db.query(sql, [this.id])
    }

    async saveWorkout(){
        const post = this.validateFields(["name", "json", "time", "date"])
        if (!post) return false
        if (!await this.isLoggedIn()) return false

        if (typeof post.time == 'object') post.time = JSON.stringify(post.time)
        let sql = 'INSERT INTO workout (user_id, name, json, time, is_template) VALUES (?, ?, ?, ?, 0)'
        let result = await this.db.query(sql, [this.id, post.name, post.json, post.time])

        let workoutId = result.insertId
        sql = "SELECT id FROM calendar WHERE user_id=? AND date=?"
        result = await this.db.query(sql, [this.id, post.date])
        if (!result.length){
            sql ="INSERT INTO calendar (user_id, date) VALUES (?, ?)"
            result = await this.db.query(sql, [this.id, post.date])
        }
        const calendarId = result.length ? result[0].id : result.insertId

        sql = 'INSERT INTO calendar_workout (calendar_id, workout_id) VALUES (?, ?)'
        result = await this.db.query(sql, [calendarId, workoutId])
        
        return workoutId
    }

    async finishWorkout(){
        const post = this.validateFields(["id"])
        if (!post) return false
        if (!await this.isLoggedIn()) return false

        let sql = 'UPDATE workout SET is_finished=1 WHERE id=?'
        this.db.query(sql, [post.id])

        return true
    }

    async workoutFinished(){
        if (!await this.isLoggedIn()) return false

        let sql = 'SELECT calendar.date from workout INNER JOIN calendar_workout ON calendar_workout.workout_id=workout.id INNER JOIN calendar ON calendar_workout.calendar_id = calendar.id WHERE workout.user_id = ? AND workout.is_template = 0 AND workout.is_finished=1'
        let result = await this.db.query(sql, [this.id])
        
        return result
    }

    async saveTemplate(){
        const post = this.validateFields(["name", "json"])
        if (!post) return false
        if (!await this.isLoggedIn()) return false

        let sql = 'INSERT INTO workout (user_id, name, time, is_template, is_finished,json ) VALUES (?, ?, "{}", 1, 0,?)'
        this.db.query(sql, [this.id, post.name, post.json])

        return true
    }

    async deleteTemplate(){
        const post = this.validateFields(["id"])
        if (!post) return false
        if (!await this.isLoggedIn()) return false

        let sql = 'DELETE FROM workout WHERE id=? and is_template=1'
        this.db.query(sql, [post.id])

        return true
    }


    async deleteExpiredResetTokens(){
        let sql = 'DELETE FROM login_reset WHERE created < (CURRENT_TIMESTAMP()  - INTERVAL 10 MINUTE);'
        return this.db.query(sql)
    }

    async validateResetToken(){
        let post = this.validateFields(["token"])
        if (!post) return false

        await this.deleteExpiredResetTokens()
        let sql = 'SELECT user_id FROM login_reset WHERE token = ?;'
        let result = await this.db.query(sql, [post.token])

        if (!result.length) return false
        return true
    }

    async generateResetToken(serverUrl){
        const post = this.validateFields(["user"])
        if (!post) return false
        this.deleteExpiredResetTokens()

        let sql = "SELECT id, username, email FROM user WHERE username=? OR email=?"
        let result = await this.db.query(sql, [post.user, post.user])
        if (!result.length) return false

        const id = result[0].id
        const reset_token = await this.generateToken(16)
        const email_token = await this.generateHash(process.env.EMAIL_TOKEN)
        this.sendRequest('POST', serverUrl, {username: result[0].username, email: result[0].email, token: reset_token, email_token: email_token})

        sql = "INSERT INTO login_reset (user_id, token) VALUES (?, ?)"
        this.db.query(sql, [id, reset_token])

        return true
    }

    async resetPassword(){
        const post = this.validateFields(["password", "token"])
        if (!post) return false

        let sql = 'SELECT user_id FROM login_reset WHERE token = ?'
        let result = await this.db.query(sql, [post.token])
        if (result.length == 0) return false

        const id = result[0].user_id
        const hash = await this.generateHash(post.password)
        this.db.query('UPDATE user SET password=? WHERE id=?', [hash, id])
        this.db.query('DELETE FROM login_reset WHERE token=?', [post.token])

        return true
    }



    async getTables(){
        if (!await this.isAdmin()) return false

        return this.db.tables
    }

    async getTableData(){
        const post = this.validateFields(["table", "page"])
        if (!post) return false
        if (!await this.isAdmin()) return false
        if (!this.db.tables.includes(post.table)) return false

        let sql = `SELECT * FROM ${post.table} LIMIT 10 OFFSET ${parseInt(post.page) * 10}`
        let result = await this.db.query(sql)
        if (result.length == 0) return {headers: this.db.structure[post.table], body:[]}

        const rowNames = Object.keys(result[0]);
        let toReturn = {headers: rowNames, body: Array(result.length).fill([])}

        let idx = 0
        result.forEach( row => {
            toReturn.body[idx++] = Object.values(row)
        })

        return toReturn
    }

    async updateTableData(){
        const post = this.validateFields(["table", "id", "values"])
        if (!post) return false
        if (!await this.isAdmin()) return false
        if (!this.db.tables.includes(post.table)) return false

        let sql = `UPDATE ${post.table} SET `
        Object.entries(post.values).forEach(([key, value]) => sql += `${key}='${value}',`)
        sql = sql.slice(0, -1)
        sql += ` WHERE id = ?`
        this.db.query(sql, [post.id])

        if (post.table === "exercise") return 1
        return true
    }

    async insertTableData(){
        const post = this.validateFields(["table", "values"])
        if (!post) return false
        if (!await this.isAdmin()) return false
        if (!this.db.tables.includes(post.table)) return false

        let sql = `INSERT INTO ${post.table} (`
        Object.keys(post.values).forEach((key) => sql += `${key},`)
        sql = sql.slice(0, -1) + `) VALUES(`
        Object.values(post.values).forEach((key) => sql += `'${key}',`)
        sql = sql.slice(0, -1) + `);`
        try{
            this.db.query(sql, [post.id])
        }
        catch {
            return 0
        }

        if (post.table === "exercise") return 1
        return true
    }

    async deleteTableData(){
        const post = this.validateFields(["table", "id"])
        if (!post) return false
        if (!await this.isAdmin()) return false
        if (!this.db.tables.includes(post.table)) return false

        let sql = `DELETE FROM ${post.table} WHERE id = ?`
        this.db.query(sql, [post.id])

        if (post.table === "exercise") return 1
        return true
    }

    async generateHash(password){
        return bcrypt.hash(password, 10).catch(err => log(1, err))
    }
    async compareHash(password, hash){
        return bcrypt.compare(password, hash).catch(err => this.log(1, err))
    }
    async generateToken(length){
        return crypto.randomBytes(length).toString('hex');
    }
    


    respond(response_code, json={}){
        json.success = response_code == 200

        if (!this.alreadyResponded){
            this.res.status(response_code).json(json)
            this.alreadyResponded = true
        }
    }
    respondSuccess(json={}){
        this.respond(200, json)
    }
    respondMissing(){
        this.respond(400, {reason: 'Missing or invalid POST field(s)', success: false})
    }


    sendRequest(method, url, body){
        const request = require('request')
        const options = {
            method: method,
            url: url,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body)
        }

        request(options, (error, response) => {
            if (error) this.log(1, error)
            console.log(response.statusCode)
        })
    }

}

module.exports = User