-- Create the products table
CREATE TABLE products (
    id SERIAL PRIMARY KEY, -- Automatically increments, unique ID
    name VARCHAR(255) NOT NULL, -- A string with a max length
    description TEXT,
    inventory INT NOT NULL CHECK (inventory >= 0), -- An integer that cannot be negative
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add a sample product
INSERT INTO products (name, description, inventory)
VALUES ('Limited Edition Sneaker', 'A very cool shoe.', 5);


CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    reservation_id VARCHAR(255) UNIQUE NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    product_id INTEGER NOT NULL,
    status VARCHAR(50) DEFAULT 'reserved', -- e.g., 'pending', 'paid', 'failed'
    stripe_payment_intent_id VARCHAR(255),
    amount NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    expires_at TYPE TIMESTAMPTZ;
    updated_at TIMESTAMP DEFAULT NOW()
);