const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'zenith_chads',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'mp4', 'webm'],
        resource_type: 'auto'
    }
});
const upload = multer({ storage });

const postSchema = new mongoose.Schema({
    content: { type: String, required:'' },
    mediaUrl: { type: String, default: null },
    mediaType: { type: String, enum: ['image', 'video', 'audio', null], default: null },
    likes: { type: Number, default: 0 },
    comments: [{ text: String, createdAt: { type: Date, default: Date.now } }],
    ipAddress: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Post = mongoose.model('Post', postSchema);

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
        if (!req.body.content && !req.file) {
            return res.status(400).json({ error: 'You must provide text or a file.' });
        }

        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const newPost = new Post({
            content: req.body.content,
            mediaUrl: req.file ? req.file.path : null,
            mediaType: req.body.mediaType || null,
            ipAddress: userIp
        });
        await newPost.save();
        res.status(201).json({ message: 'Dropped successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.post('/api/posts/:id/like', async (req, res) => {
    try {
        await Post.findByIdAndUpdate(req.params.id, { $inc: { likes: 1 } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to like' }); }
});

app.post('/api/posts/:id/comment', async (req, res) => {
    try {
        await Post.findByIdAndUpdate(req.params.id, { $push: { comments: { text: req.body.text } } });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to comment' }); }
});

app.get('/api/admin/posts', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized.' });
    try {
        const posts = await Post.find().sort({ createdAt: -1 });
        res.json(posts);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/admin/posts/:id', async (req, res) => {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized.' });
    try {
        await Post.findByIdAndDelete(req.params.id);
        res.json({ message: 'Post erased.' });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('Connected to Database.');
        app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    })
    .catch(err => console.error(err));