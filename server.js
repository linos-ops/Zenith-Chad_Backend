const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

const postSchema = new mongoose.Schema({
    content: { type: String, required: true },
    mediaUrl: { type: String, default: null },
    mediaType: { type: String, enum: ['image', 'video', 'audio', null], default: null },
    likes: { type: Number, default: 0 },
    comments: [{ 
        text: String, 
        createdAt: { type: Date, default: Date.now } 
    }],
    ipAddress: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const Post = mongoose.model('Post', postSchema);

// --- PUBLIC ROUTES ---

app.get('/api/posts', async (req, res) => {
    try {
        const posts = await Post.find().select('-ipAddress').sort({ createdAt: -1 });
        res.json(posts);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/posts/trending', async (req, res) => {
    try {
        const posts = await Post.find().select('-ipAddress').sort({ likes: -1, createdAt: -1 }).limit(20);
        res.json(posts);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/posts', upload.single('media'), async (req, res) => {
    try {
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const newPost = new Post({
            content: req.body.content,
            mediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
            mediaType: req.body.mediaType || null,
            ipAddress: userIp
        });
        await newPost.save();
        res.status(201).json({ message: 'Dropped successfully' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/posts/:id/like', async (req, res) => {
    try {
        await Post.findByIdAndUpdate(req.params.id, { $inc: { likes: 1 } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to like' }); }
});

app.post('/api/posts/:id/comment', async (req, res) => {
    try {
        await Post.findByIdAndUpdate(req.params.id, { 
            $push: { comments: { text: req.body.text } } 
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to comment' }); }
});

// --- ADMIN ROUTES ---

app.get('/api/admin/posts', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (adminToken !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Unauthorized.' });
    }
    try {
        const posts = await Post.find().sort({ createdAt: -1 });
        res.json(posts);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch admin feed' }); }
});

app.delete('/api/admin/posts/:id', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (adminToken !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Unauthorized.' });
    }
    try {
        await Post.findByIdAndDelete(req.params.id);
        res.json({ message: 'Post erased.' });
    } catch (err) { res.status(500).json({ error: 'Failed to delete' }); }
});

// --- DATABASE CONNECTION ---

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('Connected to the Database.');
        app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    })
    .catch(err => console.error('Database connection failed:', err));