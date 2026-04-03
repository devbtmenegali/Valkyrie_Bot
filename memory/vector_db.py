import os
import uuid
from supabase import create_client, Client
from langchain_google_genai import GoogleGenerativeAIEmbeddings

class VectorMemory:
    def __init__(self):
        url: str = os.getenv("SUPABASE_URL")
        key: str = os.getenv("SUPABASE_KEY")
        
        if not url or not key:
            print("AVISO: Chaves SUPABASE_URL ou SUPABASE_KEY não configuradas. Memória vetorial rodando no vazio.")
            self.supabase = None
        else:
            self.supabase: Client = create_client(url, key)
            print("VectorMemory conectado com sucesso à nuvem (Supabase pgvector).")

        # Conector do Gemini para gerar Vetores
        self.embeddings = GoogleGenerativeAIEmbeddings(model="models/text-embedding-004")

    def add_memory(self, text: str, metadata: dict = None):
        if not self.supabase:
            return str(uuid.uuid4())
            
        if metadata is None:
            metadata = {}
            
        vector = self.embeddings.embed_query(text)
        
        data = {
            "content": text,
            "metadata": metadata,
            "embedding": vector
        }
        
        response = self.supabase.table("memories").insert(data).execute()
        return response.data[0]['id'] if response.data else str(uuid.uuid4())
        
    def search_memory(self, query: str, n_results: int = 3) -> list:
        if not self.supabase:
            return []
            
        query_vector = self.embeddings.embed_query(query)
        
        # Chama a função de similaridade HNSW do Supabase que criamos
        response = self.supabase.rpc("match_memories", {
            "query_embedding": query_vector,
            "match_threshold": 0.5,
            "match_count": n_results
        }).execute()
        
        return response.data if response.data else []

