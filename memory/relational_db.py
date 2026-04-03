import os
from sqlalchemy import create_engine, Column, Integer, String, Boolean, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker
import datetime

Base = declarative_base()

class Task(Base):
    __tablename__ = 'tasks'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    description = Column(String, nullable=False)
    status = Column(String, default="Pendente") # Pendente, Em Progresso, Concluído
    due_date = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class RelationalMemory:
    def __init__(self, db_path="sqlite:///.valkyrie_relational.db"):
        self.engine = create_engine(db_path)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        
    def add_task(self, description: str, due_date: datetime.datetime = None):
        session = self.Session()
        new_task = Task(description=description, due_date=due_date)
        session.add(new_task)
        session.commit()
        task_id = new_task.id
        session.close()
        return task_id
        
    def list_pending_tasks(self):
        session = self.Session()
        tasks = session.query(Task).filter(Task.status == "Pendente").all()
        result = [{"id": t.id, "description": t.description, "due": t.due_date} for t in tasks]
        session.close()
        return result
        
    def complete_task(self, task_id: int):
        session = self.Session()
        task = session.query(Task).filter(Task.id == task_id).first()
        if task:
            task.status = "Concluído"
            session.commit()
            success = True
        else:
            success = False
        session.close()
        return success
